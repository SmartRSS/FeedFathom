# 0021 — Testing: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Test doubles and isolation

### strictFake throws on any member the test did not provide

**Where:** `src/shared/__tests__/strict-fake.ts`, `strictFake()`

A `strictFake<T>` is typed as the whole dependency but implements only what the test hands it; reading any other member throws and names it, so a handler that starts using something the test never arranged fails loudly instead of receiving undefined. Symbols and `then` read through because `await`, `expect` and the console probe for them on any value. The cast to `T` is sound only because the proxy makes the members missing from `Partial<T>` unreachable.

### Worker tests stub process.on

**Where:** `src/__tests__/worker-app.test.ts`, `spyOn(process, "on")`

`runWorker` registers SIGTERM and SIGINT handlers. Left in place they would call this test's fakes if a later file's run were interrupted, so the test spies on `process.on`.

### Assertions on poisoned values use toBe, not toEqual

**Where:** `src/features/jobs/__tests__/main.test.ts`, the acknowledgement cases

The test values carry throwing getters. `toEqual` compares structurally and would read those getters, so the assertion compares by identity with `toBe`.

### Integration tests give each test a fresh user id for Redis counters

**Where:** `src/features/feeds/__tests__/outbound-fetch-budget-integration.test.ts`, `userId()`; `src/features/feeds/__tests__/newsletter-address-integration.test.ts`, `createAccount()`

The outbound fetch budget is a Redis counter keyed by user id, and it outlives the test that filled it. Each test takes a fresh id from `process.hrtime` so no counter carries over into the next test.

## Integration tests against PostgreSQL and Redis

### The migration suite ends on a real migration

**Where:** `src/__tests__/migration-integration.test.ts`, `afterAll`

The startup-gate test forges a journal row for a build newer than this one. CI points `DATABASE_URL` and `MIGRATION_TEST_DATABASE_URL` at the same ephemeral database, so the suite migrates for real last; a forged journal left behind breaks whatever runs next against that database.

### Bun SQL queries in rejects assertions need an explicit then

**Where:** `src/__tests__/migration-integration.test.ts`, the `.then(...)` calls inside `expect(...).rejects`

A Bun SQL query runs only once `then` is called, and `expect(...).rejects` never calls it on its own, so a query asserted to reject is chained with `.then(...)` first. Removing that call makes the assertion pass without running the query.

### The scratch baseline's index function uses a schema-qualified table

**Where:** `src/__tests__/migration-integration.test.ts`, `scratchBaseline`

PostgreSQL evaluates an index expression's function with a `search_path` of `pg_catalog` alone, so `widget_y` names `"public"."widget_settings"`. The function reads a column only a pending migration adds, which PostgreSQL discovers only when it evaluates the function while building the index.

### The ownership tie fixture stores the lower id second

**Where:** `src/__tests__/migration-integration.test.ts`, "upgrading gives each email source its earliest subscriber as owner"

For the tie on `created_at`, the subscription with the lower id is inserted after the other, so it is stored and scanned second. That is what proves the tie is broken by id and not by scan order; reordering the rows would make the test pass for the wrong reason.

### Integration tests migrate with a short connect deadline

**Where:** `src/features/feeds/__tests__/source-scheduling-integration.test.ts`, `migrateDatabase(..., { deadline: 5_000 })`

The production migrator retries the connection for two minutes, which is right for a container racing PostgreSQL's first boot. A test passes a five-second deadline, so a developer with no PostgreSQL running gets a quick failure instead of two minutes of nothing.

### Integration test pools are sized on purpose

**Where:** `src/features/auth/__tests__/password-reset-integration.test.ts`, the file-level `createDrizzleConnection()`; `src/features/auth/__tests__/registration-integration.test.ts`, `max: 8`

The password reset tests share one pool for the file: every setup re-migrates, and a pool per test adds connections that stay open until the process exits. The registration race test uses a pool as wide as the race so the registrations really run on separate connections and meet at the table lock instead of queueing client-side.

### The authenticate plan test prices out sequential scans

**Where:** `src/features/auth/__tests__/sessions-integration.test.ts`, `enable_seqscan`

The test asserts both sid probes in the authenticate statement use the unique index. It sets `enable_seqscan = off` so a one-row table cannot make a sequential scan look cheaper; without the index the planner has no alternative and would still show one. It runs EXPLAIN without ANALYZE, which plans the data-modifying CTEs but runs nothing.

### Raw SQL test helpers type bigint ids as strings

**Where:** `src/features/feeds/__tests__/article-visibility-integration.test.ts`, `addArticle()`

`articles.id` is a bigint, which Bun's SQL driver returns as a string, unlike the drizzle mapping that the services use. Helpers that insert through raw SQL type the id as a string accordingly.

### The favicon slot script is tested against a real Redis

**Where:** `src/features/feeds/__tests__/favicon-refresher-integration.test.ts`

The unit tests cover the queueing rules through a fake Redis, which does not run Lua, so the slot script itself is tested against a real server.

### The article event integration test pairs Bun's client with ioredis

**Where:** `src/features/reader/__tests__/article-event-hub-integration.test.ts`

The worker publishes through Bun's Redis client and the server subscribes through ioredis, so the test holds the wire format between those two real clients. SUBSCRIBE is sent asynchronously and the hub exposes no ready signal, so the test publishes repeatedly until the first message lands, bounded at 100 attempts.

### The runtime reconnect test simulates a packet-dropping outage

**Where:** `src/platform/__tests__/runtime-integration.test.ts`, the muting proxy

A TCP proxy stands between the runtime and Redis. While muted it forwards nothing and holds new connections open without answering, which models a partition or a vanished host (dropped packets) rather than a refused connection, the case that exercises connect timeouts. The test relies on the Bun client opening the first proxied connection, before the runtime opens any other.

## Outbound HTTP tests

### The fake HTTP Redis applies expiry on every read and emulates scripts by behaviour

**Where:** `src/platform/http/__tests__/fake-http-redis.ts`, `createFakeHttpRedis()`

The rate limiter's behaviour is all about when a key stops existing, and a reservation that never expires makes every retry look like a violation, so the fake applies millisecond expiry on every read, and INCR/DECR keep an existing expiry and give a new key none, as Redis does. EVAL runs the scripts the client and the favicon refresher send by matching what each one does rather than by interpreting Lua.

### HTTP pacing tests read the limiter's clock, not wall time

**Where:** `src/platform/http/__tests__/http-client.test.ts`, `slotLoggingRedis()`; `src/platform/http/__tests__/http-rate-limiter.test.ts`

Pacing assertions use the slots the fake Redis grants, stamped by its own clock, which is the one the limiter reads; timing the transport calls would also time however long the machine took between a reservation and the call after it. Rate-limiter tests assert the wait the limiter asks `deadline.sleep` for rather than elapsed time, stop the clock with `setSystemTime` where a default interval is checked, and block a waiter's sleep until the test calls `wake()`, so a loaded machine cannot reorder events. A test that needs an interval no stall can outlast uses the real 10-second background interval.

### The 24 MiB body cap test reads the body as text

**Where:** `src/platform/http/__tests__/http-client.test.ts`, "accepts exactly 24 MiB and rejects one decoded byte over"

The cap applies to the bytes read and to the cached copy before decoding, and `Uint8Array.from` spends seconds on a body that size, so the test reads text. The body is single-byte ASCII, so its text length equals its byte count.

## Unit test fixtures

### Encoding tests write non-ASCII bodies as byte arrays

**Where:** `src/features/feeds/__tests__/feed-document.test.ts`, `fromParts()`

A test feed body stands for bytes on the wire. Markup is ASCII, so a string part is one byte per character, but non-ASCII text is always a literal byte array, because a JS string would already be decoded and the test would not exercise the decoder.

### Time-dependent fixtures pin their instants

**Where:** `src/features/feeds/__tests__/cap-entry.test.ts`, `fetchedAt`; `src/features/feeds/__tests__/unchanged-poll-integration.test.ts`, `pubDate`

The MeteoAlarm CAP fixture holds one entry current at the time it was fetched, one already expired, and one expired entry edited to status Test with a later expiry, so `fetchedAt` pins that instant. The unchanged-poll test uses one `pubDate` for every parse, because pubDate also sets the article's `updated_at`, and a clock second ticking between two parses would read as an edit.

### Date tests build dates in local time

**Where:** `src/spa/__tests__/format-date.test.ts`

The tests construct dates with local-time constructors (`new Date(2026, 8, 7, 15, 0)`) so they hold in any time zone. An ISO string with `Z` would make "today" depend on the machine's zone.

### Favicon normalisation fixtures start from a V4 BMP

**Where:** `src/features/feeds/__tests__/favicon-normalization.test.ts`, `v4Bmp()`

A 32-bit BMP with a V4 header is the only BMP format that `Bun.Image` decodes with alpha, so it is the source for the PNG and JPEG fixtures.

### Feed-parser golden fixtures pin the replaced parser and sanitizer

**Where:** `src/features/feeds/__tests__/feed-parser-golden.test.ts`; `src/features/feeds/__tests__/feed-parser-golden/`

The 49 XML fixtures are pseudonymised derivatives of `@rowanmanning/feed-parser` v2.1.5's integration suite (served by `rowanmanning/sample-feeds`, GPLv3): article text, names and hosts are replaced deterministically while keeping every structural element, attribute, namespace, escaping style, date, ID format and malformed-input edge case intact, with the GPLv3 section 5 modification notice recorded in `src/features/feeds/__tests__/feed-parser-golden/LICENSE`. Each `<name>.expected.json` was regenerated by running FeedFathom's previous pipeline at commit `58f8bda8` (with `@rowanmanning/feed-parser` 2.1.5 and `sanitize-html`) against those pseudonymised fixtures with a fixed source URL per file and `now = 1700000000000`. The expected files pin the replaced libraries' behaviour in FeedFathom's output shape; never regenerate them from the current parser or sanitizer.

### Bun lacks some browser APIs, and the SPA tests are shaped around that

**Where:** `src/spa/__tests__/extension-reader.test.ts`, `bridgeWindow()`; `src/spa/__tests__/reader-extraction.test.ts`

Bun's `MessageEvent` accepts only a `MessagePort` as its source, so the bridge test sets `source` with `Object.defineProperty`. Bun has no `DOMParser`, so reaching the parser throws a ReferenceError: a TOO_LARGE rejection proves the budget turned the page away before any DOM work, and for pages under the budget the Readability modes are expected to fail, with the test asserting only that the failure is not TOO_LARGE.

### The SPA import-graph test skips require-call edges

**Where:** `src/spa/__tests__/import-graph.test.ts`, `spaGraph()`

Bun's transpiler injects its own JSX runtime as a require-call; the SPA's real static edges are ES imports. Counting require-calls would report the injected runtime as part of the main chunk, and dynamic imports are skipped because they land in chunks of their own.

### Service worker tests run the bundle the build produces

**Where:** `src/spa/__tests__/sw.test.ts`, module setup

The tests bundle `sw.ts` with `Bun.build` as an IIFE, the way `bin/build-spa.ts` does, and run it in a fresh context per test. The in-memory Cache API fake deletes before each `put`, so a replaced entry moves to the end as it does in the real Cache API; the worker's pruning depends on that insertion order.

## Playwright browser suite

### The SPA browser suite blocks service workers

**Where:** `tests/browser/spa.spec.ts`, `test.use({ serviceWorkers: "block" })`

Once the real service worker activates, its own `fetch()` calls run outside the page's network stack, bypass `page.route()` mocks and hit Vite's dev proxy, which has no backend. A slow test lets the worker finish installing mid-run and fail with ECONNREFUSED, so the suite blocks it and every request stays on the mocked path; a page under this setting is as uncontrolled as one after a hard reload.

### Routes that must also catch worker fetches are installed on the context

**Where:** `tests/browser/api-fixture.ts`, `installApiFixture()`; `tests/browser/reader-extension.spec.ts`; `tests/browser/spa.spec.ts`

A route installed on the `BrowserContext` also answers what a controlling service worker fetches, while a page route does not. Tests that run with a worker install the fixture and any holding route on the context.

### A route registered after the fixture takes precedence

**Where:** `tests/browser/spa.spec.ts`, per-test `page.route()` overrides

Playwright runs the most recently registered matching handler first, so a test registers its override after `installApiFixture` and calls `route.fallback()` for everything it does not handle.

### Fixture responses are validated against the contract at runtime

**Where:** `tests/browser/api-fixture.ts`, `respond()`, `malformed()`

The fixture answers as the server does, checking each body against the contract the SPA decodes it with both at lint time and when the test runs, because a spread escapes TypeScript's excess-property check and the contracts are exact. `malformed()` exists for answers that break the contract on purpose.

### The event stream answers 204 by default

**Where:** `tests/browser/api-fixture.ts`, the `/api/events` route

204 is the one answer `EventSource` never retries, so by default the dashboard runs on its timer poll, as it does behind a proxy that eats streams.

### Local test runs never reuse an existing server

**Where:** `tests/browser/playwright.config.ts`, `webServer.reuseExistingServer`

A server already on the port may be another checkout's, serving other code, so the run fails instead of reusing it; `PLAYWRIGHT_PORT` picks a free port.

### Offline tests cut the API with a route, not only setOffline

**Where:** `tests/browser/spa.spec.ts`, `removeOffline()` and the offline listing test

`context.setOffline` cuts the network only for the page; routes still answer the service worker, so the tests stand in for the network with a route that aborts `/api/**` and wins over the fixture's. The dev server serves no built shell, so a reload offline is impossible and the list is first requested once already offline.

### Chromium does not abort a service worker's forwarded request

**Where:** `tests/browser/spa.spec.ts`, `navigatePastHeldArticles()`

A controlling service worker forwards the page's request with its signal, but Chromium does not abort `FetchEvent.request.signal` when the page cancels, so the worker's network fetch runs on. Only the page's own fetches are counted when checking that abandoned article bodies are cancelled.

### Aborted requests reject route.fallback()

**Where:** `tests/browser/spa.spec.ts`, holding routes for tree, article and article-page requests

When the app aborts a request a test is holding, the route cannot be answered and `route.fallback()` rejects; the tests swallow that rejection because the abort is the behaviour under test.

### Observer and listener ordering tells a test when the app has run

**Where:** `tests/browser/spa.spec.ts`, `intersectionsDelivered()` and the scroll and click probes; `tests/browser/reader-extension.spec.ts`

A fresh observer's first callback runs in the same notification as, and after, those of every older observer, so creating one and awaiting its first callback means the app's pending intersection or mutation callbacks have run. Likewise, a listener added after the app's runs after the app's handler, which lets a probe read what the app did with the event.

### Binding re-evaluation is counted by instrumenting builtins

**Where:** `tests/browser/spa.spec.ts`, the row re-evaluation and tab-stop tests

Solid writes the DOM only when a binding's value changes, so a mutation count cannot measure how many rows re-run their bindings; the tests temporarily wrap `Set.prototype.has` or `Array.prototype.some` and count calls. Solid runs the bindings synchronously inside the event handler, so the count is complete when the dispatch returns.

### Prefetch requests are read in an idle callback

**Where:** `tests/browser/spa.spec.ts`, `recordedArticleRequests()`

The app queues its article prefetch in an idle callback, so the recorded requests are read in one too; any prefetch queued before the read has run by then.

### The reader bridge fixture keeps its images off the network

**Where:** `tests/browser/spa.spec.ts`, the reader bridge init script

The bridged HTML uses `data:` image URLs so a failed request cannot land in the console-error guard instead of the assertion. The default image has no loading hint, so whatever it ends up with is the app's sanitize default. The hostile page's image fails to decode without the network and asks for eager loading, because the app's lazy default would keep a detached copy from loading at all.

### The popup test drives popup.html directly

**Where:** `tests/browser/extension-popup.spec.ts`

Chromium always has `chrome.contextMenus`, so the missing-API path where `background-event.ts` falls back to `action.setPopup` (Firefox for Android only) cannot be exercised. The test covers `popup.html` and `popup.ts` directly, the UI mobile falls back to, against the `chrome.storage.session` cache the background script keeps regardless of `contextMenus` support.

## Model checking

### A TLA+ model checks how refresh requests coalesce onto the ParseSource job

**Where:** `src/features/feeds/__tests__/source-enqueue-model/`; `bin/model-check.sh`; `.claude/skills/verify-source-enqueue/SKILL.md`

The bugs in this protocol (#813, #845, #847, #1196, #1197 and the re-enqueued follow-up that d1a82e4d removed) were each an order of Redis and BullMQ steps that no unit test had arranged. TLC tries every order for one source, three concurrent `enqueueSource` calls, the poll, one worker and the post-finish requeue. Each of the six fixes is a flag the configs revert, and the check fails unless every reverted variant breaks the property and the current one keeps it. `src/features/jobs/__tests__/refresh-race-integration.test.ts` forces the #1196 and #1197 orders against Redis and a real BullMQ worker. The model does not read the code: a change to the covered functions is caught only when the model is changed to describe it, which the skill walks through. `tla2tools.jar` is downloaded at a pinned version and SHA-256 rather than vendored, and only Java is needed to run it.

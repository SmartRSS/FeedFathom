# FeedFathom — context

FeedFathom is a self-hosted RSS and newsletter reader. A **server** serves the
SPA and the JSON API, a **worker** fetches and parses feeds on a schedule, a
**migrator** brings the schema up to date and exits, and optional browser
extensions add feed discovery and reader views. PostgreSQL stores accounts,
subscriptions and articles. Redis holds the job queue and the HTTP cache.

## Where a new file goes

> Put a file in the feature that owns the behaviour it implements. If more than
> one feature owns it, it belongs in `platform` (infrastructure) or `shared`
> (contracts, types, dependency-free helpers) — not in a third feature.

## Layers

Four layers. Each may depend only **downward**.

| Layer | Holds | May import |
| --- | --- | --- |
| `src/shared/` | Contracts, validation policy, shared types, dependency-free helpers, the feed scanners | nothing inside `src/` |
| `src/platform/` | Config, DB connection and table definitions, HTTP client and transport, Redis, queue | `shared` |
| `src/features/*` | One feature's routes, data services and domain logic, together | `platform`, `shared`, declared sibling features |
| `src/spa/`, `src/extension/` | Client applications with their own build targets | `shared` |

Entrypoints — `src/server.ts`, `src/worker.ts`, `src/migrator.ts`, plus
`src/runtime.ts` and `src/server-app.ts` — sit at the `src/` root and may
import anything. They are the composition roots.

`tools/oxlint-plugin.js` enforces this with the `feedfathom/layer-boundaries`
rule, which carries the DAG in its `.oxlintrc.json` options. Prose alone did
not hold. The lint rule is the load-bearing half. Relative specifiers are
resolved and judged by the same rule, so `../../` is not an escape hatch.

Co-located `*.test.ts` files are exempt: a test arranges state rather than
wiring the product, and ships in no bundle. Anything two clients both need is
`shared` by that same definition, which is where the scanner tree, the
reader-bridge protocol in `extension-types.ts` and the URL-safety helpers in
`util/safe-url.ts` live.

## Features

`auth`, `feeds`, `reader`, `admin`, `mail-ingest`, `jobs`.

Cross-feature dependencies are real and are written down rather than wished
away. The declared DAG:

```
auth        → (none)
feeds       → auth
reader      → feeds, auth
admin       → feeds, auth
mail-ingest → feeds
jobs        → feeds, admin
```

Any edge not on that list is a lint error. The list must also stay acyclic,
which is checked in review rather than by the rule. That's the point of
keeping the edges in a config file: adding one is a deliberate act that shows
up in the diff, instead of arriving as a quiet new import.

- **`auth`** — sessions, registration, activation, password, the users data
  service, and the mail sender that carries activation mail. The session plugin
  lives here rather than in `platform`: session verification is domain logic
  about users, not infrastructure.
- **`feeds`** — getting content and the store it lands in: feed parsing
  (RSS/Atom, JSON Feed, microformats), OPML import, discovery and preview,
  subscription, WebSub, favicons, article extraction and link rewriting, and
  the sources, articles, user-sources and folders data services.
- **`reader`** — the reading surface over that store: the articles, article,
  folders, tree and source routes.
- **`admin`** — the admin and options routes and the job-failures data service.
- **`mail-ingest`** — inbound newsletter mail: the `/api/mail` webhook, the
  email handler, the email processor, and the Cloudflare email worker.
- **`jobs`** — the worker main loop.

## Imports

Cross-directory imports use package.json subpath imports — `#shared/*`,
`#platform/*`, `#features/*` — not relative paths and not `tsconfig` `paths`.
Bun, TypeScript's bundler resolution, Vite and knip all resolve them natively,
whereas `paths` would need mirroring in each. Within a directory, relative
imports are fine.

`import/extensions: ["error", "always"]` applies to subpath imports too:
specifiers keep their `.ts` suffix.

## Errors

An error type with a canonical HTTP representation is mapped once, in the
composition root's error hook, next to the types already mapped there —
`NotFound`, `ValidationError`, `DecodeError` and `HttpDeferredError`.

A route handler catches an error only when it can do something a central
mapping could not. `find` is the example: it knows the URL it just failed to
fetch came from the user, so that failure is a client error rather than a
server one. It re-raises anything else.

Guard a caught value with a helper such as `isHttpDeferredError` rather than a
bare `instanceof` — what reaches an error hook is whatever was thrown, and
`instanceof` can itself throw on a proxy with a poisoned `getPrototypeOf` trap.

## Outbound HTTP

Every request the server makes to a feed, a hub or a favicon goes through
`HttpClient` (`get` for feeds and favicons, `post` for a WebSub hub
subscribe). One path, so one place governs politeness: the per-host interval
and block in `http-rate-limiter.ts`, the cache in `http-cache-policy.ts`, and
the private-network guard in the native transport. A second outbound path that
reaches for the global `fetch` gets none of that, which is how the hub
subscribe drifted out of the rate limiter.

The rate-limit keys are per hostname; ADR 0002 records why, and what evidence
would justify revisiting it.

## Extracting logic

Decision logic lives in a dependency-free module beside whatever uses it, with
a co-located test. Classes and components keep I/O, storage and rendering. A
verdict, an interval, a transition or a selection is a candidate as soon as
answering it requires a database, a Redis, a browser or a network — that
requirement is the bug, not the size of the file holding it.

The criterion is testability, not line count. A long file whose decisions are
all extracted is finished. Splitting it further buys a smaller file and
nothing else.

Two clusters were deliberately left in place on exactly that basis: the WebSub
lifecycle methods on the sources data service, and the cache read/write half of
the HTTP client. Both are pure I/O with the decisions already lifted out, so
moving them would cost a rewiring across their callers and gain no test.

Extracted SPA logic goes in one behaviour module per view — `behavior.ts` keeps
only genuinely cross-view concerns. A single shared module would become the new
large file and would change for several unrelated reasons.

## Tests

Unit tests are co-located: `foo.test.ts` sits in a `__tests__/` subdirectory
next to `foo.ts` (i.e. `__tests__/foo.test.ts`).

A co-located test that needs a real PostgreSQL is named
`foo-integration.test.ts`. `test:unit` skips every `*-integration.test.ts`
wherever it lives and `test:migrations` names them explicitly, so `bun run
test:unit` stays runnable with nothing but the repo checked out. Needing a
database is not a reason to move a test away from its module.

This holds outside `src/` too: `bin/`, `tools/` and `vendor/` each carry their
own `__tests__/`. `tests/` holds only the Playwright specs under
`tests/browser/`, which test a running app rather than a module.

A test that asserts on a module's file path, its directory, or which file an
export comes from tests structure rather than behaviour. Delete the assertion.

There is no component test harness. No test imports a `.tsx`: `bun test`
resolves `.tsx` against React's JSX runtime rather than the configured
`solid-js` one, and the SPA's `.svg?raw` imports are a Vite feature the test
runner cannot resolve. Component behaviour is covered by the Playwright specs.
Anything that needs a unit test has to come out of the component first.

## Glossary

- **Source** — a feed as the system stores it, fetched once and shared by every
  subscriber. Distinct from a **user source**, one user's subscription to it.
- **Article** — an entry parsed out of a source. **User article** carries the
  per-user read state.
- **Scanner** — a strategy that inspects a fetched page and reports the feeds it
  advertises. Runs both server-side and inside the extension content script,
  which is why the scanners live in `shared`.
- **Feed preview** — a parsed-but-not-subscribed feed held in Redis between the
  discovery request and the subscribe request.
- **Deferred response** — a 429 telling the client the work is queued and to
  retry, rather than blocking on a fetch.

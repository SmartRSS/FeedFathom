# 0013 — Platform HTTP: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Rate limiting and pacing

### Both priorities share one per-host clock kept in Redis time

**Where:** `src/platform/http/http-rate-limiter.ts`, `HostIntervals`, `reserveScript`

Extends ADR 0002. Each priority has its own gap, measured since the last request of either priority to the same host, so any mix of the two stays at no more than one request per interactive gap. The reserve script reads Redis's `TIME`, not the caller's clock, so every server and worker instance agrees. The key only needs to outlive the longest gap.

### Background work defers on a busy host; interactive work waits inside its deadline

**Where:** `src/platform/http/http-rate-limiter.ts`, `Priority`, `HttpRateLimiter.reserve()`

Background work is the poller, which has other sources to poll and can come back later, so a blocked or busy host defers it at once instead of holding a worker slot. Interactive work has a person waiting and the SPA has no retry for a deferral, so a block that clears inside the request deadline is slept through. Concurrent interactive waiters on one host take the clock in turn, one interactive gap apart, and keep waiting past the first interval, so the third of three queued requests is served rather than deferred with most of its deadline left. A wait that cannot finish inside the deadline is deferred up front instead of being slept into a deadline error.

### The limiter's own pacing has its own error type because it always clears

**Where:** `src/platform/http/http-deferred-error.ts`, `HttpPacedError`; `src/features/feeds/favicon-refresher.ts`

A block the origin asked for raises `HttpDeferredError`. A deferral caused by this instance's per-host interval raises the subclass `HttpPacedError`, so a caller can tell the two apart. A paced deferral always clears within one interval whatever the origin says, so `favicon-refresher` never counts it toward its deferral horizon. Folding it back into `HttpDeferredError` would let routine pacing give up on favicons.

### The interactive waiter counter expires on its own and never goes negative

**Where:** `src/platform/http/http-rate-limiter.ts`, `registerWaiterScript`, `releaseWaiterScript`, `waiterGraceMs`

Each interactive waiter increments a per-host counter whose expiry only ever grows, to the last waiter's deadline plus a one-second grace that lets its final attempt and cleanup land, so a waiter that crashes leaves state that still disappears. Release leaves no key, never a counter at -1, when the counter has already expired, and the last waiter out deletes the key. The release runs outside the deadline, unawaited, with its error ignored: a request that ran out of time still gives its slot back, and the expiry covers a release that fails.

### An unusable Retry-After blocks the host for five minutes

**Where:** `src/platform/http/http-rate-limiter.ts`, `retryAtFrom()`

Retry-After may be delta-seconds, an HTTP date, or nonsense. A missing or unusable value falls back to five minutes, not to "now", so a malformed header cannot turn a 429 into a hot retry loop against a host that has just asked us to stop. A date in the past is honoured as-is, meaning "try again now".

### Origin RateLimit headers stop us at one remaining, in either name form and either reset unit

**Where:** `src/platform/http/http-rate-limiter.ts`, `rateLimitBlockUntil()`, `resetEpochThresholdSeconds`

The block starts when one unit remains, not zero, because the request that would spend the last unit is the one worth holding back. Both the RFC 9331 names and the older `X-RateLimit-*` forms are read, since the `X-` forms are still the common ones. RFC 9331 defines the reset as delta-seconds while GitHub and others send a Unix timestamp; the magnitudes do not overlap (1e9 seconds is September 2001 as an epoch and 31 years as a delta), so smaller values are deltas and larger ones epochs. Reading a delta of 60 as an epoch would give 1970 and silently drop the header.

### A deferral or an expired deadline is never blamed on the fetched URL

**Where:** `src/platform/http/http-deferred-error.ts`, `isNoAnswerError()`

`HttpDeferredError` and `HttpDeadlineError` both mean no answer was received, and the error hook maps them to 429 and 504. A caller that classifies fetch failures, such as discovery of a user-supplied URL, must re-raise these instead of reporting the URL as broken; otherwise a busy host or a slow moment reads as "this address doesn't serve a feed".

## Retries, redirects and deadlines

### One wall-clock deadline bounds a whole outbound request

**Where:** `src/platform/http/request-deadline.ts`, `RequestDeadline`

The fetch, every retry, every redirect hop and the sleeps between them share one budget, because a per-attempt timeout does not bound a request that keeps making progress: five retries each just under their limit, or an endless redirect chain, run far past what the caller would wait. The transport gets the deadline's abort signal, so expiry cancels an in-flight read. A `sleep()` longer than the remaining budget rejects with `HttpDeadlineError` instead of sleeping past the deadline, and `endsAt` lets a caller about to wait check whether the wait fits. `dispose()` clears the timer, which otherwise keeps the process alive after a fast request.

### Retries are interactive-only and each attempt reserves the host again

**Where:** `src/platform/http/http-client.ts`, `maxAttempts`, the retry loop

An interactive caller gets one request and two retries; background work does not retry in place. Each attempt reserves the host's slot again, so the attempts sit an interval apart instead of three requests landing inside an interval that exists to allow one. A fixed backoff would ignore the per-host pacing.

### Retry-After is honoured on any error status

**Where:** `src/platform/http/http-client.ts`, `deferIfLimited()`

Retry-After is not a 429-only header (RFC 9110 10.2.3). The client records the host's rate-limit headers and defers on a 429 or on any error response that carries Retry-After, such as a 503, destroying the response first. Treating a 503 with Retry-After as an ordinary retryable error would re-request it within a fraction of a second, the opposite of what the origin asked for.

### Redirects are followed by hand, one reserved request per hop

**Where:** `src/platform/http/redirect-policy.ts`, `RedirectPolicy`

Extends ADR 0002. Each hop is its own request to a host of its own, so it is reserved against that host's rate limiter inside the loop rather than once per call; this is also what gives a retry its interval, since every attempt re-enters the loop. A resolved chain counts as permanent only if every hop was 301 or 308, because one temporary hop means the URL could change back. Reading the hostname for the reservation is safe because the first URL is validated and every later one is built by `new URL`.

### post() is paced like get() but never cached or redirect-following

**Where:** `src/platform/http/http-client.ts`, `HttpClient.post()`

The WebSub hub POST reserves the host's interval, honours its block and records a Retry-After it sends back, because a handful of shared hubs carry a large share of all feeds and an import would otherwise fire them back to back. A POST body is not cacheable, and a 3xx target is fully hub-controlled, so a redirecting hub is reported to the caller as its status. The hub URL comes from the feed, so the POST is held to the same private-network guard as `get()`, whatever `requestHubSubscription` checks first. It runs at interactive priority although both callers are the worker, because a subscribe is a one-shot side effect with no retry queue behind it.

## HTTP cache

### The cache stores only 200 responses

**Where:** `src/platform/http/http-cache-policy.ts`, `cachedResponseSchema`, `cacheable()`; `src/platform/http/http-client.ts`, the 304 branch of the fetch path

Every caller reads only a 200. A stored 304 has no body to serve and would be refreshed by every later 304, sticking the feed (#1078); a legacy entry with any other status fails the schema read and is deleted. Some CDNs answer an unconditional request with a 304: with nothing cached that is an origin failure (`HttpPolicyError`), not an empty success, and nothing is stored, so the next request goes out unconditional.

### Per-requester responses never enter the shared cache

**Where:** `src/platform/http/http-cache-policy.ts`, `sharedCacheAllowed()`

The cache is shared by every user of the instance. A response carrying `no-store`, `private`, `Vary: *` or a `Set-Cookie` belongs to one requester, and replaying it to another user would leak data, so it is never stored.

### Freshness rules are conservative toward origins and intermediaries

**Where:** `src/platform/http/http-cache-policy.ts`, `deltaSeconds()`, `currentAge()`, `expiresAt()`, `refresh()`

A delta-seconds value counts only as a bare non-negative integer, optionally quoted because some origins quote Age; anything else is absent rather than zero, so a malformed value falls through to the next rule. Current age is the greater of the gap since Date and any reported Age, so a lying intermediary can shorten freshness but never extend it. `s-maxage` outranks `max-age` because this is a shared cache, a repeated or unparseable `max-age` expires immediately, and the carried age is subtracted. On a 304 refresh, Age is dropped unless the 304 restated it and Date is stamped to now if the 304 omitted it, so the refreshed entry does not look as old as the response it replaced.

### A stale response with a validator is still cached, under its final URL

**Where:** `src/platform/http/http-cache-policy.ts`, `cacheable()`

An already-stale response is worth storing when it carries a validator, because the next fetch becomes a conditional request that can return 304. The entry records the response's own post-redirect URL, falling back to the requested one, because that is what a later request must revalidate against.

### A seeded cache entry keeps only content-type and link

**Where:** `src/platform/http/http-client.ts`, `seededCacheHeaders`, `seedCache()`

Extends ADR 0003. The hub's signature, its cache directives and its Date describe the push, not the feed document, so only the headers the parser reads are stored with the seeded body.

### A cache hit never reports a permanent redirect

**Where:** `src/platform/http/http-client.ts`, the cache-hit response mapping

A response served from the cache sets `redirectedPermanently: false`. A cache hit is not a fresh redirect decision, and the fetch that stored the entry already persisted any permanent redirect.

### The feed body cap is one global ceiling sized off the largest real feed

**Where:** `src/platform/http/http-cache-store.ts`, `maximumFeedBodyBytes`

The 24 MiB cap is sized off the largest feed actually polled: Project Zero inlines full exploit write-ups (12.6 MiB, growing about 1.3 MiB per post), while the rest of a 227-source corpus fits under 1 MiB. It is one global ceiling, not a per-source budget. The worst case is `WORKER_CONCURRENCY` downloads all at the cap against the worker's memory limit, which is safe only because a single source is that large; add per-source budgets if a second heavyweight appears.

### copyBody uses the Uint8Array constructor

**Where:** `src/platform/http/http-client.ts`, `copyBody()`

The body is copied so the caller never sees Buffer's shared pool. The `Uint8Array` constructor copies in bulk; `Uint8Array.from` iterates byte by byte and held about 440 MiB to copy a 20 MiB body (#1031).

### A failed cache lock release is ignored

**Where:** `src/platform/http/http-cache-store.ts`, `HttpCacheStore.releaseCacheLock()`

Release deletes the per-URL lock only while its token still matches. A failure to release is swallowed because the lock expires shortly after the request deadline anyway.

## Request identity

### The User-Agent reports subscribers the way Feedfetcher did, and only when real

**Where:** `src/platform/http/identity.ts`, `buildUserAgentPrefix()`, `buildUserAgent()`; `src/platform/http/http-client.ts`, `HttpRequestOptions.subscribers`

Subscriber counts in the User-Agent are often the only audience feedback RSS gives a publisher. Google's Feedfetcher set the shape (`...; 4 subscribers; feed-id=...`) and publishers scrape the literal word, so "subscribers" stays plural even at one. Fetches with no subscribers behind them (discovery, preview, favicons) omit the clause, and a non-integer count is dropped, since a phantom count would poison the numbers this exists to make truthful. The build tag and instance host tell instances apart; the build tag is omitted when `FEEDFATHOM_BUILD` is unset rather than guessed from the image tag, and the `+` slot keeps the project URL because a self-hosted domain tells the publisher nothing.

### Identity values are filtered, not escaped, before they enter a header

**Where:** `src/platform/http/identity.ts`, `sanitizeIdentity()`

The instance host and build tag come from environment variables and land in an outgoing header. Every character outside `[\w.:-]` is dropped, which still covers hostnames with a port and every tag shape the build produces, and excludes the `;`, `)`, CR and LF that would let a mis-set variable break the header or forge the convention's grammar. An empty result counts as absent.

## Internal routes

### The healthcheck answers only exact loopback addresses

**Where:** `src/platform/http/internal-routes.ts`, `healthcheckResponse()`, `createInternalRoutes()`

The probe runs inside the container and nobody outside needs to learn whether the process is up, so any peer other than `127.0.0.1`, `::1` or `::ffff:127.0.0.1` gets 403. Exact literals replace a range check because the local peer address is always one of those three. The server's route always reports ready; ADR 0020 records why that is safe.

### The container port is a literal that compose.yml repeats

**Where:** `src/platform/http/internal-routes.ts`, `containerPort`; `compose.yml`, `x-app-healthcheck`

Both processes listen on port 3000 inside their container, and the compose healthcheck probes that port as a literal. Changing `containerPort` without changing the compose healthcheck marks every container unhealthy.

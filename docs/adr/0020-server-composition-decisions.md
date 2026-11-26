# 0020 — Server composition: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Startup, readiness and shutdown

### The server waits for the migration before listening

**Where:** `src/server.ts`, `waitForMigration()` before `app.listen()`

Requests must never reach a schema the server was not built for, so the server listens only after the required migration is in place. This is also why the server's healthcheck route (`createInternalRoutes()` in `src/platform/http/internal-routes.ts`) reports ready unconditionally.

### The worker healthcheck answers 503 until BullMQ is consuming jobs

**Where:** `src/worker-app.ts`, `runWorker()`; `compose.yml`, `x-app-healthcheck.start_period`

The healthcheck port opens before startup finishes, so a probe gets a definite answer instead of a refused connection, but that answer is 503 until both BullMQ workers, the main one and the one answering server requests (ADR 0012), consume jobs, which needs the schema the build was compiled against and a reachable Redis. Answering "ok" earlier let `up --wait` and Swarm's start-first rollout stop the old workers in favour of new ones still blocked on startup, so feed polling stopped while every check was green. The healthcheck's `start_period` keeps the not-ready window from reading as a crash loop, so it must cover a normal migration; a migration too slow for that budget is rolled out by hand.

### The event hub ends streams before a graceful stop

**Where:** `src/server-app.ts`, `stopServerApp()`

Extends ADR 0007. A graceful stop waits for open responses, and `/api/events` streams never finish on their own, so the article event hub closes them first. Without that, shutdown hangs until the orchestrator kills the process.

## Request handling

### Routes are mounted after the hooks

**Where:** `src/server-app.ts`, `createServerApp()`

Elysia hooks only reach routes registered after them, so every route group is `.use`d after the request, response and error hooks. Moving a group above them silently drops logging, headers and error mapping for it.

### The error hook rewrites validation, mail rejection and deadline errors

**Where:** `src/server-app.ts`, the error hook in `createServerApp()`

Elysia's own `ValidationError` body dumps its internal validation state, so it is replaced with the plain `invalidRequestMessage` envelope clients read. A `MailRejectedError` is the sender's fault: it answers the mail relay's rejection status so the relay bounces it, and it is not logged as an error, which keeps spam to unknown addresses out of the error log. An `HttpDeadlineError` is our own budget running out, an upstream timeout rather than a malformed request, so it answers 504. A request the worker did not answer in time throws the same error, so it answers 504 too (ADR 0012).

### Retry-After on a deferral is clamped to an hour

**Where:** `src/server-app.ts`, `deferredResponse()`

A deferred request answers 429 with Retry-After so the client comes back. `retryAt` can come straight from an upstream Retry-After header with no sanity check of its own, so the value sent to clients is clamped between one second and one hour.

### The body-size cap is set on the server and equals the fetch cap

**Where:** `src/server-app.ts`, `createServerApp()`, `serve.maxRequestBodySize`

Bun buffers the whole body before any schema validation runs, so a per-route limit comes too late and the cap has to sit at the server level. The largest legitimate body is a WebSub-pushed feed document, which can carry anything a fetch could, so the cap is `maximumFeedBodyBytes`.

### The CSP restricts scripts only

**Where:** `src/server-app.ts`, `contentSecurityPolicy()`

Feed content loads images, media, styles and frames from anywhere, so there is deliberately no `default-src` for those to fall back to. Scripts are limited to `'self'`, the shell's inline scripts by hash, and Turnstile's origin only while a site key enables the captcha.

## Logging

### Only slow requests are logged, by route pattern

**Where:** `src/server-app.ts`, `logSlowRequest()`

Requests under the threshold log nothing, so the log stays a signal instead of an access log. The line names the route pattern (for example `/api/favicon/:id`), never the raw path with its query string, so the log cannot leak article URLs or search terms.

### Request start times live in a WeakMap keyed by Request

**Where:** `src/server-app.ts`, `requestStartedAt`

The `request` hook runs before routing on a lighter context than the one `afterResponse` and `error` receive, so the start time cannot be threaded through context. A WeakMap keyed by the `Request` needs no cleanup once the response is logged or the request is dropped.

## Bundle

### Spreading a service module keeps all its services in the server bundle

**Where:** `src/server.ts`, the `services` object; `src/features/feeds/services.ts`, `faviconRefresher`, `retentionService`

The server spreads whole feature service modules into `createServerApp`, which keeps every service in the bundle, including the worker-only `faviconRefresher` and `retentionService` that no route reaches. That is accepted because their constructors only store their arguments, so they cost code size alone.

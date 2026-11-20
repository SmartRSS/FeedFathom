# 0010 — Reader: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Article routes

### Unread badges are recomputed from the store after every read or delete

**Where:** `src/features/reader/routes/articles.ts`, `deleteArticlesHandler()`, `patchArticlesHandler()`

After marking articles read or removing them, the route calls `recomputeUnreadCounts` for every affected source rather than adjusting a count by a delta. A delta kept in the route drifts from the store under concurrent writes; a recount from the store cannot.

### Article deletes are logged with the client-reported trigger

**Where:** `src/features/reader/routes/articles.ts`, `deleteArticlesHandler()`, `MAX_TRACE_LOG_LENGTH`

Deletes are terminal, and at one point they arrived with nobody able to say what sent them (see `src/spa/delete-trace.ts`), so every delete writes one `articles.delete` log line with the trace the client sends. The trace is client-supplied, so it is capped at 4000 characters, and `JSON.stringify` keeps it on one line whatever it contains.

### The article routes reject malformed lists and keep defaults in the data service

**Where:** `src/features/reader/routes/articles.ts`; `src/shared/contracts/requests.ts`, `articlesRequest`

An empty article id list is a client bug and gets a 422, not a no-op 200. An absent `filter` means unread, and that default lives in the data service so no caller spells it out. Revisions are returned only when the request asks for them, because SPA bundles from before #992 reject the extra field.

## Tree and snooze

### Snooze is a display-level filter evaluated wherever unread is read

**Where:** `src/features/feeds/user-source-data-service.ts`, `setSourceSnooze()`; `src/features/reader/routes.ts`, `createReaderRoutes()`; `src/features/reader/routes/tree.ts`, `getTreeHandler()`; `src/features/feeds/article-data-service.ts`, `getUserArticlesForSources()`; `src/shared/util/snooze.ts`, `isSnoozed()`; `src/shared/contracts/requests.ts`, `snoozeSourceRequest`

Snoozing a source (#725) writes only the per-user `pausedUntil`. Parsing, saving, article state and the stored unread count carry on, so the backlog survives the pause; zeroing counts at snooze time would lose it and need a job to restore it. The tree and the unread article list test the timestamp when they read, so expiry needs no job, and the "all" and "read" views do not suppress the source, so the backlog stays reachable. A missing, past or unparseable value means not snoozed, which is also how an early un-pause is stored, so the request schema accepts a past timestamp.

### A source shows as failing only after two consecutive failures

**Where:** `src/features/reader/routes/tree.ts`, `failingAfter`

One failed fetch is usually a blip the next poll recovers from. Two in a row, with the backoff between them, is worth telling the reader about.

## Event stream

### The article event hub uses ioredis and ends every stream on close

**Where:** `src/features/reader/article-event-hub.ts`, `ArticleEventHub`, `ArticleEventSubscriber`

The subscriber is an ioredis connection because ioredis resubscribes on its own after a reconnect, and it stays open until `close()` so a reconnecting dashboard does not churn it. `close()` is terminal and ends every open stream, because the server's graceful stop waits for in-flight responses and an open SSE stream would hold shutdown until the kill. A `listen()` after `close()` is ended on a microtask, so the caller finishes wiring up first and the stream is not missed. `close()` uses `disconnect`, not `quit`, because QUIT would queue behind a SUBSCRIBE waiting out a Redis outage and a subscriber has nothing to flush. Extends ADR 0007.

### The event stream disables Bun's idle timeout and flushes headers at once

**Where:** `src/features/reader/routes/events.ts`, `getEventsHandler()`, `heartbeatMs`

Bun closes a connection idle for 10 seconds, so the handler sets `server.timeout(request, 0)`; the 25-second heartbeat stays under Cloudflare's 100-second and nginx's 60-second idle cuts. The stream opens with `retry: 10000` and a comment line so the headers go out at once and `EventSource` sees it open before the first article. An abort during the initial source lookup fires before the abort listener exists, so the handler checks `request.signal.aborted` by hand before registering it. Extends ADR 0007.

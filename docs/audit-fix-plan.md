# Correctness / latency fix plan

Source: two independent full-codebase reviews (2026-08-04), cross-checked against
an earlier audit whose fixes were lost in a data-recovery incident. Priority
order: correctness first, then per-request latency (throughput deliberately
deprioritized per project owner's preference).

Explicitly deferred, not in this plan:
- **Session expiry** — permanent sessions are an intentional feature for now.
  Revisit only if there's a refresh-token design that's genuinely easy to get
  right and isn't itself leak-prone (proper rotation/reuse-detection is not
  "easy," so this is parked, not scheduled).
- **`/api/favicon/:id` missing ownership check** — accepted risk, favicons
  aren't sensitive.

Process for each item below: implement → two independent review agents →
apply their (verified) feedback → repeat until both come back clean → move on.

## Status

- [x] Reverse tabnabbing (`target=_blank` without `rel=noopener`) — fixed and
      deployed. Took 3 review rounds: initial fix missed email content and
      only allowlisted `rel` as a name (not value); round 2's conditional
      fix was bypassable via `target="_BLANK"`/whitespace; final fix forces
      `rel="noopener noreferrer"` unconditionally on every `<a>`.
- [x] Bound `HttpClient`'s interactive wait for `/api/preview` and `/api/find` —
      fixed and deployed (3 review rounds). `interactiveWaitMs` 11s -> 2.5s;
      `HttpDeferredError` now surfaces a real `Retry-After`/message computed
      from `retryAt` instead of a static "few seconds" (which was wrong by
      up to 2 orders of magnitude for genuine upstream rate-limit blocks),
      clamped to 1h. Known pre-existing, currently-unreachable landmine not
      fixed (out of scope): `new HttpDeferredError(NaN)` throws a raw
      `RangeError` instead of constructing cleanly, because the constructor
      does `new Date(retryAt).toISOString()` eagerly. Not reachable today
      (the one caller that could pass NaN validates first), but worth a
      guard if a future call site skips that validation.
- [x] Cross-account leak: offline mutation IndexedDB queue not cleared on logout —
      fixed and deployed (2 review rounds). Round 1's `deleteDatabase()` call
      silently no-op'd (`onblocked` treated as success) since the SW never
      closed its own IndexedDB connections. Round 2: SW now closes its
      connection after every queue operation, and logout switched to
      `open()+clear()` on the object store (doesn't need exclusive access
      the way `deleteDatabase` does). sw-v4.js -> sw-v5.js.
- [x] `removeUserArticles` has no ownership check on article IDs — fixed and
      deployed. Inner-joins against `userSources` (same pattern as
      `getUserArticle`), returns only the authorized subset; verified live
      against the dev DB that a user cannot soft-delete another user's
      articles.
- [x] Job failures for everything except `ParseSource` vanish with no durable record —
      fixed and deployed. Took 7 review rounds, each finding a narrower
      unguarded-throw path in `processJob`'s catch block than the last (an
      adversarial/poisoned job error must never itself cause `processJob` to
      reject, or BullMQ would see the job as failed instead of the failure
      living in Postgres per this codebase's "always acknowledge"
      convention): record() unguarded -> message construction unguarded ->
      console.error unguarded (poisoned inspect symbol) -> the
      `HttpDeferredError` instanceof check itself unguarded (poisoned
      prototype) -> using the classification (retryAt getter /
      moveToDelayed) unguarded -> the `DelayedError` instanceof check in
      that fallback unguarded. New `job_failures` table (migration 0019),
      hand-written and validated in a rolled-back transaction. Deployed via
      the manual Oracle pipeline (image rebuild + Swarm service update +
      one-off migrator job) since the CI/CD pipeline described in
      docs/running.md was mid-migration on this branch. Note: a concurrent
      session was found actively modifying this branch/deployment host
      during this item; a test-file revert it caused mid-review was
      recovered and re-verified.
- [x] `cleanup()`'s empty-subquery mass-delete risk on `sources` — fixed and
      deployed. 3 attempts: a separate existence-check query before the
      delete was TOCTOU-vulnerable (not atomic with the delete); rewriting
      `notInArray` as a correlated `notExists` didn't fix anything (still
      deletes everything when `user_sources` is globally empty -- caught
      by testing directly against Postgres before committing); final fix
      combines an uncorrelated `exists(user_sources has any row)` guard
      with the correlated per-row `notExists` check in one DELETE
      statement, verified against real Postgres (rolled back) for both
      the empty-table case (0 deleted) and the genuine-orphan case (only
      unsubscribed sources deleted).
- [ ] Literal NUL byte in `article-data-service.ts`'s dedupe key
- [ ] `batchUpsertArticles` partial-batch failure skips recompute for committed batches
- [ ] OPML import aborts entirely on one malformed outline instead of skipping it
- [ ] `createUser` takes a full-table lock on every registration, not just first-admin bootstrap
- [ ] `GatherFaviconJobs` has no concurrency cap, can starve `ParseSource`
- [ ] No `AbortController` on superseded tree/article requests
- [ ] `flushQueue()` retries permanently-failed mutations forever, no user-visible failure
- [ ] Ambiguous 409 vs 404 on folder deletion (not-found vs not-empty conflated)
- [ ] Duplicate feed URLs silently dropped in extension's context menu

Deprioritized / reconsidered, not scheduled unless asked:
- Moving OPML import and inbound-email processing to the worker queue. Given
  today's finding that synchronous work is fine when it's not actually
  network-bound (see the subscribe cache-hit fast path), these may not need
  moving at all — worth a fresh look with that lens before doing the work,
  not blindly deferring to the worker.

## Detail per item

### 1. Reverse tabnabbing
`src/lib/rewrite-links.ts` sets `target="_blank"` on absolute links (~lines 69,
80) without `rel="noopener noreferrer"`. `src/lib/extract-article.ts`'s
sanitizer allowlist for `<a>` (~line 17) doesn't permit `rel` to survive
either. Fix: add `rel="noopener noreferrer"` alongside both `target="_blank"`
sets, and add `"rel"` to the sanitizer's allowedAttributes.a array.

### 2. HttpClient interactive-wait latency
`src/lib/http-client.ts` `reserve()` (~407-452): per-hostname Redis `SET NX`
slot, 10s hold, up to 11s polling wait at "interactive" priority.
`/api/preview` and `/api/find` in `src/routes/reader.ts` await this inline.
Fix direction: give preview/find a shorter interactive ceiling (fail fast with
a clear "try again" error instead of hanging up to 11s), or a separate
priority lane that doesn't contend with the worker's background throttle for
the same host.

### 3. Cross-account offline-queue leak
`src/spa/public/sw-v5.js`'s IndexedDB `mutation-queue` store isn't cleared on
logout (`src/spa/options-admin.tsx`'s `logout()` only clears Cache Storage
`api-*`). Fix: clear the IndexedDB store too, bump SW version per the
established rename convention since the file is being touched again.

### 4. `removeUserArticles` missing ownership check
`src/db/data-services/article-data-service.ts` `removeUserArticles` doesn't
verify article IDs belong to sources the caller is subscribed to before
inserting soft-delete rows. Fix: inner-join against `userSources` (same
ownership-scoping pattern as `getUserArticle`/`getUserArticlesForSources`)
before inserting, only return the authorized subset.

### 5. Silent job-failure swallowing
`src/lib/workers/main.ts`'s job processor only records durable failure state
for `ParseSource` (via `failSource`). `RefreshFavicon`/`Cleanup`/`GatherJobs`
failures are `console.error`'d and the job still reports "completed" to
BullMQ. Fix: a small `job_failures` table + write calls from the shared catch
block, proportionate to a single/few-user self-hosted app (no logging
framework).

### 6. `cleanup()` mass-delete risk
`src/db/data-services/user-source-data-service.ts` `cleanup()`:
`notInArray(sources.id, <subquery over user_sources>)` — Postgres `NOT IN
(empty set)` is true for every row, so a transiently-empty `user_sources`
subquery would delete every source. Fix: guard against an empty subquery
before running the delete.

### 7. NUL byte corruption
`src/db/data-services/article-data-service.ts` `batchUpsertArticles`'s dedupe
key template literal has a literal `\x00` instead of a space (confirmed via
direct byte inspection). Fix: replace with a plain space.

### 8. Partial-batch recompute gap
`batchUpsertArticles` processes batches of 10 sequentially, not atomically; a
later-batch failure leaves earlier batches committed but skips the recompute
for those sources. Fix: track sourceIds with at least one committed batch,
recompute for those before re-throwing on partial failure.

### 9. OPML import aborts on one bad entry
`src/lib/opml-parser.ts` (~99-101): a feed-type outline with empty `xmlUrl`
throws and kills the whole import instead of skipping that entry. Fix: skip
malformed entries, keep importing the rest.

### 10. `createUser` full-table lock
`src/db/data-services/user-data-service.ts` `createUser` (~35-39)
unconditionally takes `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE` on every
registration, not just to resolve the first-admin bootstrap race. Fix: only
take the lock (or use a lighter mechanism) when a fast unlocked check finds
the table empty.

### 11. `GatherFaviconJobs` concurrency
No cap distinct from general `WORKER_CONCURRENCY`; a large favicon-refresh run
can starve `ParseSource` job processing. Fix: bound concurrent favicon jobs
per run.

### 12. No request cancellation for superseded selections
`src/spa/dashboard.tsx`: rapid tree/article navigation fires a new fetch per
action without cancelling the previous in-flight one (only ignored via
counters). Fix: `AbortController` per request generation, threaded through
`src/spa/api.ts`'s `api()` helper.

### 13. `flushQueue()` retries forever
`src/spa/public/sw-v5.js` `flushQueue()` only removes a queued mutation on
`response.ok`; a definitive 4xx failure is retried forever with the
optimistic UI having already told the user it succeeded. Fix: remove on
definitive failure, surface it to the user somehow.

### 14. Ambiguous 409 on folder deletion
`src/db/data-services/folder-data-service.ts` `removeEmptyUserFolder`
conflates "not found/not owned" with "not empty" (both return 0 affected
rows). Fix: distinguish existence+ownership from emptiness.

### 15. Extension context-menu duplicate feed URLs
`src/extension/background-event.ts` (~87-96): duplicate feed URLs cause
`chrome.contextMenus.create` to reject, silently dropping that menu entry.
Fix: dedupe `feedsData` by URL before building menu items.

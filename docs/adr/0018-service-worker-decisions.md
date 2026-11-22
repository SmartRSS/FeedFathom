# 0018 — Service worker: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Accounts and offline removals

### Each sign-in period has its own API cache

**Where:** `src/spa/sw.ts`, `CacheScope`, `scopedCache()`, `changeScope()`, `adoptScope()`, `changeAccount()`; `src/spa/sw-protocol.ts`, `forgetAccountData()`

The API cache holds one account's answers, and a revoked or expired session reaches the login form without logging out, so the next sign-in may be another account (#974). Each sign-in period gets its own cache, named `api-v8-<uuid>` and held by a `CacheScope`. A successful sign-in or logout starts a new scope and deletes every other API cache before the page sees the response. Work keeps the scope it began under. A response in flight when the scope changes is written through the handle opened before the change, into a cache that no name reaches any more, and `scopedCache()` opens nothing for a scope that is no longer live, so a late write cannot recreate an old cache. The tree preload and the favicon prune state live on the scope, so a new account starts without them. The page repeats the purge in `forgetAccountData` for pages no worker controls, such as after a hard reload, and posts `account-changed` so that a worker which did not see the sign-in starts a new scope too. A restarted worker adopts the one `api-v8-` cache it finds, so offline articles survive the worker stopping, and deletes every API cache when it finds anything else. A sign-in keeps queued removals because each carries its owner, a logout drops them, and a queue that cannot be cleared must not block the logout.

### Queued removals carry the account that made them, and the server checks it

**Where:** `src/spa/sw.ts`, `namedAccount()`, `queueableMutation()`, `replayEntry()`; `src/spa/dashboard.tsx`, `ownerHeaders()`; `src/shared/contracts/headers.ts`, `accountHeader`, `accountMismatchStatus`

Two accounts can share a source, so replaying account A's removals under account B's session would unsubscribe B or hide B's articles (#982). The session cookie is HttpOnly, and a sign-in in another tab can replace it between any check the worker makes and the request it sends, so only the server can compare the two (ADR 0009). The dashboard names its account in `X-FeedFathom-Account` on every removal, the worker stores that account with a removal it queues, and the replay sends it back. The server answers a replay under another account with 412, and the worker drops it without telling the page, because the page now shows an account that never made the removal. A removal that names no account fails offline at once instead of answering a success that never lands, and a queued entry with no account, from before #982, is dropped. The worker queues a removal only when the header is the decimal string of a safe integer, the one form the server's string comparison can match, so a header the server refuses online is not queued offline and replayed as some other id. A page loaded before the header, still open under this worker, sends its removals without it, so it can no longer queue them offline. Online they pass as before. The worker keeps no record of who is signed in.

The worker relies on the server check, so the check must be live in production before this worker ships, in an earlier deploy. A Swarm start-first rolling update keeps the old server answering while the new one starts, and the old server ignores the header. A new worker that replays through it would apply account A's removal as account B, which the worker's own session lookup used to prevent.

### Offline removals replay from a hand-picked table

**Where:** `src/spa/sw.ts`, the `Removals` type and the queueing fetch path

Only DELETE removals are queued offline, each with the request field its response echoes, so the worker can fake the optimistic success and the UI updates at once while the real request replays later. Generic mutation queueing was rejected because most mutations (subscribe, folder create) return server-generated data that cannot be faked offline. Denied background sync is acceptable because `flushQueue` also runs on the next successful API request.

### Queue replay is serial, in order, and drops an entry only on a final rejection

**Where:** `src/spa/sw.ts`, `replaying`, `isRefusal()`, `queueMayHaveEntries`, `flushQueue()`

Only one replay runs at a time, since an overlapping one would send entries the running one has not deleted yet; a call during a replay schedules one more afterwards. A 4xx other than 401 is final: the optimistic response already claimed success, so the entry is dropped, the page is told, and later entries still go out. A 412 is dropped without telling the page, as the entry above says. A 401 (the same account may sign back in) and a 5xx (presumed transient) retry forever and hold back later entries, because the server refuses to remove a folder that still holds a source, and a folder removal replayed past a failed source removal would be rejected and dropped (#975). A failed client notification must not read as "still offline" and stop the queue. `queueMayHaveEntries` starts true so the first flush checks what an earlier instance left, and is cleared before the read so an entry queued mid-flush sets it again; otherwise it spares every successful GET an IndexedDB round trip.

## Shell and asset caching

### The service worker file is named by a content hash

**Where:** `src/shared/contracts/service-worker-file.ts`, `serviceWorkerFile()`, `serviceWorkerPathPattern`; `bin/build-spa.ts`

The build names the worker by a content hash of its bundle, because a new URL is what moves clients onto a changed worker: Cloudflare can hold a cached copy past what Cache-Control suggests. The server matches the name with `serviceWorkerPathPattern` to give the worker its own caching headers, so the pattern must match every name the build produces.

### The shell is cached asset-first and served only when complete

**Where:** `src/spa/sw.ts`, `putShell()`, `completeCachedShell()`, `shell()`, `pruneShell()`

`putShell` stores the assets a shell names before the HTML, so a cached "/" never points at files the cache lacks; hash-named assets already cached are never re-fetched, and a failed precache is left for `cacheFirst` to fill on the next visit. A cached shell is served only while every asset it names is cached, because a past deploy's assets are gone from the server and a partial copy loads a blank page. Navigation is cache-first so a warm launch paints at once, and the network copy replaces the cache for the next launch. The worker's URL hashes only its own bundle, so a changed asset list (the `shell-updated` message) is what tells open pages about a page-only deploy.

### Asset pruning follows the files that name chunks and fonts

**Where:** `src/spa/sw.ts`, `pruneShell()`

Lazy chunks are named by the entry script and fonts by the stylesheet, not by the HTML, so pruning keeps the assets the served shell names plus what its scripts and stylesheets name as `assets/<file>`. A previous deploy's assets stay until a newer shell has been served, so tabs still running the old shell can load their chunks. Pruning stops if an entry file is missing, because its references cannot be told apart from a past deploy's, and its failure must never block the shell update.

### Cache versions change only to purge everything

**Where:** `src/spa/sw.ts`, `SHELL_CACHE`, `API_SCOPE_PREFIX`; `src/spa/sw-protocol.ts`, `apiCachePrefix`

Every cache holding one account's API responses starts with `apiCachePrefix`, and the version after it is bumped only to force-purge every entry when the caching scheme itself changes. The API caches moved to `v8` when each sign-in period got its own cache, and a worker that starts beside a `v7` cache deletes it. The shell cache stays at `v7` because its scheme did not change. Bumping a version for ordinary deploys would throw away offline articles, or download every asset again, for no reason.

## API caching

### Some API paths bypass the worker entirely

**Where:** `src/spa/sw.ts`, the fetch router (`/api/options/opml`, `/api/events`)

The OPML export is a file download, not application state: caching it with `networkFirst` would put the whole subscription list in the Cache API and, offline, return a stale export without saying so. The event stream never ends, so `networkFirst` would tee it into a cache write that never completes, and an offline fallback would replay old signals.

### Navigation starts the tree fetch for the page to reuse

**Where:** `src/spa/sw.ts`, `CacheScope.treePreload`, `cachedTree()`; `src/spa/sw-protocol.ts`, `cachedTreeQuery`

On a dashboard-bound navigation `shell()` starts the `/api/tree` fetch before the page's bundle loads, and the page's own tree request reuses it instead of making a second round trip. The preload belongs to the scope it started under, so a tree preloaded before a sign-in is never served after it. Separately, `/api/tree?cached` is answered from the worker's cache alone so boot can paint a cached tree while the real request is in flight (#989); it never goes to the network, and a miss is a bare 504 that the page reads as "nothing cached".

### Opened articles are cached briefly and trimmed per path

**Where:** `src/spa/sw.ts`, `FETCHED_AT`, `ARTICLE_FRESH_MS`, `ARTICLE_CACHE_LIMIT`, `QUERY_CACHE_LIMIT`, `trimPath()`

The dashboard prefetches the next article in idle time (#716), so a cached copy younger than a minute is served without a round trip; the body carries no read state, and a feed update in that window shows on the next open. Cached articles carry their fetch time in a header so their age survives worker restarts. Nothing else evicts an opened article before the sign-in period ends, and each query string is its own entry (`/api/find`, `/api/preview`), so every path keeps only its newest few. `trimPath` relies on `cache.keys()` listing entries in insertion order, with a put moving an entry to the end.

### Favicons are content-addressed and pruned to the latest tree

**Where:** `src/spa/sw.ts`, the `/api/favicon/` route, `pruneFavicons()`, `CacheScope.prunedFavicons`; `src/features/reader/routes/tree.ts`, the favicon `?v=` fingerprint

The tree route appends a fingerprint of the favicon as `?v=`, so a path always decodes to the same bytes and a cached favicon is served cache-first with no revalidation. A miss bypasses the HTTP cache so copies stored there before favicons carried their CSP are not copied in. A changed icon gets a new URL and removed sources leave icons behind, so only the icons the latest tree names stay cached. The scope remembers the set it last pruned to, so a tree that names the same icons costs no scan of the cache.

## Offline reading

### Offline reading keeps a bounded, account-scoped set of unread bodies

**Where:** `src/spa/sw.ts`, `OFFLINE_ARTICLE_PATH`, `OFFLINE_VERSION`, `offlineSyncs`, `offlineQueue`, `syncOfflineArticles()`; `src/spa/sw-protocol.ts`, `offlineArticleLimit`, `offlineArticleMaxAgeDays`, `postOfflineSync()`

The page owns the setting: each sync posts the sources with something unread, and an empty list switches offline reading off (#992). Bodies are bounded by count (500) and age (14 days), enough for a commute or a flight; a byte budget is the upgrade if media-heavy bodies prove too large for a phone. They live in the API cache under their own key, so `trimPath` leaves them alone and a sign-in or logout empties them with the rest of the account. Each body stores the row's revision so a rewritten article is fetched again, while an outdated body stays readable until its replacement lands. Syncs run one after another and a newer one (or the option going off) stops an older one, aborting its stalled requests; downloads run two at a time so they never crowd out the article the reader opens, and a hidden tab, failed request or going offline ends the run for the page's next sync to resume.

### The offline article list reproduces only what the kept rows can answer

**Where:** `src/spa/sw.ts`, `offlineArticleList()`; `src/spa/sw-protocol.ts`, `cursorPublishedAtHeader`

Offline, the unread list is answered from the rows the last sync kept, scoped as the server scopes it, limited to rows whose body is stored and that were not removed offline; other filters and search fail as a network error rather than return a wrong answer. Paging follows the server's (publishedAt, id) newest-first order whether the previous page came from the worker or the network. `Date.parse` collapses the server's sub-millisecond timestamps, so the cached row position, not the parsed date, keeps the server's order after a kept cursor, and the page sends the cursor's publishedAt in a header so the worker can place a cursor whose row has since left the kept rows.

## Worker code

### The worker declares its own scope types and lint exceptions

**Where:** `src/spa/sw.ts`, the `ExtendableEvent` and `FetchEvent` types, `notifyClients()`

The project's type library is the DOM's, which has no service worker scope, so the file declares by hand only the slice of the worker global scope it uses. `Client.postMessage` takes no target origin, so the lint rule written for `window.postMessage` is suppressed where the worker posts to its clients.

### Worker JSON is read at its contract types without runtime checks

**Where:** `src/spa/sw.ts`, `uncheckedJson()`

The worker reads back only JSON its own origin produced: server answers, the page's requests and its own cache entries. Validating them against the typebox contracts would pull typebox's runtime into the worker and grow the bundle about ninefold, so the worker trusts the contract types unchecked.

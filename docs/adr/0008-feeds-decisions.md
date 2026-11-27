# 0008 — Feeds: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Article store and read state

### The subscription join authorizes every article read and write

**Where:** `src/features/feeds/article-data-service.ts`, `userArticleAccessJoin()`, `getUserArticlesForSources()`, `markUserArticles()`; `src/shared/contracts/requests.ts`, `articlesRequest`

Every article query joins `user_sources` for the requesting user, and that join, not the caller's arguments, decides which rows the user may see. This makes the `allSubscribed` scope safe with an empty source list, and a folder id that is not the user's matches none of their subscriptions (#976). Folder, search (#697) and Today (#715) requests are scoped on the server and send `sources` empty, so a folder is not bound by the 500-id cap on an explicit source list. Article ids are a guessable serial key, so `markUserArticles` filters the caller's ids down to subscribed sources before it writes any read or removal state. Extends ADR 0006.

### Article visibility and read state each have one SQL definition

**Where:** `src/features/feeds/article-read-state.ts`, `subscriptionSeesArticle`, `unreadCondition`, `readCondition`, `notRemovedCondition`; `src/features/feeds/article-data-service.ts`, `getUserArticlesForSources()`, `setUserArticlesRead()`; `src/shared/contracts/responses.ts`, `articleSummaryResponse.read`

A subscription sees an article when the feed listed it at or after the subscription began. The article list, the `read` flag the server computes for each row, `recomputeUnreadCounts` and retention all use these expressions, because two queries that answer the same question drift apart and an unread badge with nothing behind it is the hardest failure to notice. Unread compares `read_at` with `articles.updated_at`, so a post rewritten after you read it is unread again; `readCondition` spells out `updated_at IS NULL` because `NOT (updated_at > read_at)` is NULL for an unedited article. A removal is terminal and hidden in every filter, marking read never touches `deleted_at`, read and unread partition the rest, and the count tests for the article row itself, because a subscription with no articles leaves the LEFT JOIN's state columns NULL.

### A removal outlives its article row

**Where:** `src/platform/db/schemas/user-articles.ts`; `src/features/feeds/article-data-service.ts`, `userArticleStateJoin()`

`user_articles` is keyed and joined on `(source, guid)`, not on the article id, and has no foreign key to `articles`. A removal must survive retention pruning the row and the feed listing the same guid again under a fresh id, and must survive a publisher edit that bumps `articles.updated_at`.

### Article lists page by a keyset cursor that names a row

**Where:** `src/features/feeds/article-data-service.ts`, `getUserArticlesForSources()`, `cursorRow`; `src/shared/contracts/requests.ts`, `articlesRequest.cursor`

Paging is a keyset over `(published_at, id)` rather than OFFSET, so a folder over hundreds of sources does not rescan every row above each page, and the page-sized LIMIT bounds what the query loads. `id` breaks ties because a feed can publish a batch with one timestamp. The cursor is the id of the previous page's last row and the query reads that row's timestamp back through a self-join: a client's JSON date has lost the microseconds and would land inside the batch it was meant to follow. Extends ADR 0006.

### Article listing picks the page from the covering index, then loads its rows

**Where:** `src/features/feeds/article-data-service.ts`, `ArticlesDataService.getUserArticlesForSources()`

The inner pass picks the page using only columns `articles_source_published_covering_idx` carries, and the Today window filters on the same index, so it stays a range scan. The outer pass joins back to `articles` for author, title and url of that page alone; in one pass a 20-source folder read 27k heap pages per listing. A join does not keep a subquery's order, so the outer pass orders again.

### Article reads name their columns so the search vector is never fetched

**Where:** `src/features/feeds/article-data-service.ts`, `getUserArticle()`

`articles` carries a generated tsvector (#697). Selecting whole rows would copy the body, split into lexemes, into every response. Extends ADR 0006.

### An article's revision is PostgreSQL's printed updated_at

**Where:** `src/features/feeds/article-data-service.ts`, `getUserArticlesForSources()`; `src/shared/contracts/responses.ts`, `articleSummaryResponse.revision`

`revision` is the text form of `updated_at`, which changes when a feed rewrites the article; a body downloaded for offline reading (#992) compares it to tell its copy is stale. It is text because a rewrite can move `updated_at` by one microsecond, which a JSON date loses. It is null until a feed first rewrites the article and is sent only when the request asks for it.

### The article upsert dedupes, batches per source, and sizes batches to the bind limit

**Where:** `src/features/feeds/article-data-service.ts`, `batchUpsertArticles()`

A feed can list the same `(source, guid)` twice, and PostgreSQL rejects an `ON CONFLICT DO UPDATE` batch that targets one row twice, so payloads are deduped keeping the last occurrence. Batches are split per source so the newest-subscription lookup is an uncorrelated subquery evaluated once per statement. At 11 columns, 100 rows is about 1100 bind parameters, far below the 65535 limit, and fits a typical feed in one round trip.

### The article upsert reports only changes a badge recount can see

**Where:** `src/features/feeds/article-data-service.ts`, `batchUpsertArticles()`

The return value counts inserted rows, rows whose content or timestamps changed, and rows a newer subscription could not see until this write re-stamped them; zero means no recount. RETURNING sees only the new row, so the old `updated_at` and visibility are read first, and a concurrent write in between can only make the count too high. `updated_at` is compared as text because a JS Date drops microseconds. Enclosures are written on every update but are not part of the change test: an attachment is not a revision, and rows stored before enclosures existed would all read as rewritten.

### An unchanged article is re-stamped only after the throttle, unless a newer subscription needs it

**Where:** `src/features/feeds/article-data-service.ts`, `batchUpsertArticles()`; `src/features/feeds/retention.ts`, `lastSeenBumpThrottleHours`; `src/features/feeds/feed-parser.ts`, `FeedParser.parseSource()`

An unchanged row is written only once its `last_seen_in_feed_at` is an hour old (#897): every write copies the whole row into every index, and with polls every few minutes nearly all were no-ops that also recounted every subscriber's badge. `parseSource` also allows the `lastBodyHash` unchanged-body skip when `websubStatus` is `"none"` and the HTTP `Link` header advertises no hub, because a bit-for-bit identical body already yielded no hub on the previous parse. OPML import creates subscriptions without writing articles, and a subscription sees an article only once the stamp reaches its `created_at`, so a stamp older than the source's newest subscription is moved regardless. The throttle must stay below the gone-from-feed buffer's 24-hour floor, or retention deletes articles still in the feed.

### PostgreSQL's clock stamps subscriptions, article sightings and fetch success

**Where:** `src/features/feeds/article-data-service.ts`, `batchUpsertArticles()`; `src/features/feeds/user-source-data-service.ts`, `addSourceToUser()`; `src/features/feeds/opml-import-service.ts`, `insertTree()`; `src/features/feeds/source-data-service.ts`, `successSource()`; `src/features/feeds/article-import.ts`, `ArticleImporter.recordFetch()`

A subscription sees an article when `last_seen_in_feed_at` reaches its `created_at`, so both come from `NOW()` and never from a process clock. Mixed clocks fail in two ways. A JS `Date` drops microseconds, so a fetch in the same millisecond as a subscription created with `NOW()` sorts before it and hides every article until the next re-stamp (#1200). The API server and the worker each read their own clock, so a lagging worker hides a new subscriber's articles for the length of the lag. `last_success` takes `NOW()` too, because retention reads an article stamped before `last_success` less the gone-from-feed buffer as dropped. The batches commit before `successSource` runs, so one fetch's articles precede its `last_success` by the import's duration, far inside the buffer's 24-hour floor. An email subscription backdated to its source's `created_at` keeps that stamp. A CAP alert already expired at import time is left out, which matters when the fetch is replayed from a stored preview.

### Unread badges are recounted only when a row changed, an upsert failed, or the import is one-off

**Where:** `src/features/feeds/article-import.ts`, `ArticleImporter.importArticles()`

Most polls change nothing and the recount aggregates every retained article against every subscriber (#897), so it runs only when a row changed. `batchUpsertArticles` commits batch by batch, so after a failure the badges are recounted anyway and the upsert error re-raised, with a recount error only logged. `alwaysRecount` serves one-off imports (subscribe, mail), where a retry after a crash between upsert and recount changes no row but still has a badge to fix.

### Unread counts are recomputed with one correlated count per subscription

**Where:** `src/features/feeds/user-source-data-service.ts`, `recomputeUnreadCounts()`

The correlated subquery reads `user_articles` by its primary-key prefix `(user_id, source_id)` one subscription at a time. As a single join across every subscriber the planner hash-joined it, and each feed fetch sequentially scanned every user's read state (#1035).

### An article event is published fire-and-forget, after the unread recount

**Where:** `src/features/feeds/article-events.ts`, `ArticleEventPublisher.publish()`

The publish follows the recount so a client reloading on the signal reads the new counts. It is not awaited and never throws: during a Redis outage the command waits in Bun's offline queue, and awaiting it would hold up the write it announces. Extends ADR 0007.

## Retention

### The gone-from-feed buffer scales with each source's own cadence

**Where:** `src/features/feeds/retention.ts`, `confirmedGoneFromFeedBuffer`, `goneFromFeedBufferFloorHours`

One fetch omitting an item means nothing, so an article must stay unseen for many of the source's cycles before it counts as dropped. A flat threshold cannot tell five days missing from a five-minute feed (about 1400 fetches) from three days missing from a feed with a two-day max-age, and a flat one-day buffer once destroyed 89k articles' deletion records. The buffer is ten times `not_before - last_success`, or ten times the WebSub fallback poll for WebSub sources, with a 24-hour floor; every degenerate case lands on a larger buffer.

### Gone-for-good articles are pruned only when every subscriber who could see them deleted them

**Where:** `src/features/feeds/retention.ts`, `articlesUnreachableByAnyone`

"Could have seen" covers only subscribers who joined before the article disappeared, so a later subscriber's missing deletion row does not block the prune. A false positive is recoverable because a removal outlives the article row; the buffer exists because refetching is waste, not because being wrong is destructive.

### Articles only dormant users could see are pruned after the stale threshold

**Where:** `src/features/feeds/retention.ts`, `articlesOnlyDormantCouldSee`

The other rules count a subscriber idle for months as current. This rule deletes articles older than `ARTICLE_STALE_AFTER_DAYS` when no subscriber who could have seen them was active within `USER_DORMANT_AFTER_DAYS`, regardless of deletions. Either threshold at 0 disables the rule; 0 never means "no requirement".

### Articles from before a source's earliest subscription are pruned

**Where:** `src/features/feeds/retention.ts`

What a source carried before anyone subscribed is something no subscriber can see. The cutoff is the earliest subscription alone, so a later subscriber joining does not delete what an earlier one can still read.

### Newsletter articles age out on delivery age alone

**Where:** `src/features/feeds/retention.ts`, `emailRetentionDays`, `deleteUnreachableRows()`

An email source has no feed to drop an item from, and every delivery stamps `last_success`, which would make every earlier newsletter look dropped, so the gone-from-feed rule skips it. A newsletter a current subscriber could have seen is pruned at 90 days of delivery age whether or not anyone deleted it, so an active subscriber who never deletes does not keep every row forever.

### The orphan-source delete guards against an empty table and spares new sources

**Where:** `src/features/feeds/retention.ts`, `subscriberless`, `inSubscriberlessGrace`, `subscriberlessGraceEnd`

With `user_sources` empty, "delete sources nobody subscribes to" deletes every source: right after the last unsubscribe, a disaster after a transient wipe or a partial restore. The rule requires the table to have any row, in the same statement so there is no check-then-delete race. A source younger than a day is kept regardless: it covers a newsletter address reserved before anyone subscribes (#1116) and the gap between `addSourceToUser` creating a source and subscribing to it, at the cost of a day of polling for an abandoned new feed.

### An expired owner's newsletter address passes to the earliest active subscriber

**Where:** `src/features/feeds/retention.ts`, `deleteUnreachableRows()`; `src/features/feeds/user-source-data-service.ts`, `UserSourcesDataService`

Migration 0013 made the earliest subscriber of an older shared email source its owner; the others keep their subscriptions, may subscribe again idempotently, and cannot return once they leave. When the owner expires, ownership passes to the earliest active subscriber, because deleting the source would cascade away the others' rows; even a rollback to code without the handoff must leave their subscriptions and mail intact. An unshared source loses its owner (`reserved_by` SET NULL) and falls to the orphan delete. One cutoff serves both statements so no user expires between them.

### An owned newsletter address that has received mail stays as a tombstone

**Where:** `src/features/feeds/retention.ts`, `tombstone`, `deleteUnreachableRows()`; `src/features/feeds/source-data-service.ts`, `findMailRecipient()`

Deleting an owned address that has had mail would let any account create it and receive its owner's mail, so the row stays, its articles are deleted, and `findMailRecipient` bounces new mail to it once the reservation grace has passed. An address that never had mail is deleted, or every Generate click would leave a row forever. Email delivery is the only writer of an email source's `last_success`, which is what marks "has had mail".

### The prune recounts the unread totals of the sources it touched

**Where:** `src/features/feeds/retention.ts`, `RetentionService.prune()`

The deletes bypass the data services, so without a recount a pruned unread article keeps its badge until an unrelated event recounts the source (#812).

## Polling and the parse queue

### Polls have a floor an origin cannot lower

**Where:** `src/features/feeds/source-schedule-policy.ts`, `pollFloorMs`

No feed is polled again sooner than five minutes, whatever the caller or the origin's `Cache-Control` asks. An origin sending `no-cache` or `max-age=0` must not make the poller hit it every gather cycle.

### A new source is due at once through not_before's default

**Where:** `src/platform/db/schemas/sources.ts`, `not_before`; `src/features/feeds/source-data-service.ts`, `SourcesDataService.getSourcesToProcess()`

A never-fetched source is due because `not_before` defaults to the Unix epoch. `successSource` always clamps forward to the floor and cannot produce "due now" itself.

### Verified WebSub sources poll daily and ignore not_before

**Where:** `src/features/feeds/source-data-service.ts`, `getSourcesToProcess()`; `src/features/feeds/websub-state-service.ts`, `markWebSubVerified()`, `markWebSubFailed()`; `src/features/feeds/source-schedule-policy.ts`, `webSubFallbackPollMs`

A `feed` source is gated only by `notBefore`, which `successSource` and `failSource` write, so nothing is computed at read time. A verified subscription sets kind `websub`, polled once a day by `lastAttempt` as a safety net for dropped pushes; it ignores `notBefore`, which a `Cache-Control` value would otherwise pull inside a day. A failed subscription returns to kind `feed`, because a dead one marked `websub` would be checked only daily with no push to make up for it.

### One ParseSource job per source, and a refresh that cannot merge waits on a marker the next run takes

**Where:** `src/features/feeds/source-enqueue.ts`, `SourceEnqueuer`, `parseSourceJobId()`, `pendingParseRefreshKey()`; `src/features/jobs/main.ts`, the `completed` listener, `MainWorker.requeuePendingRefresh()`

The per-source job id is BullMQ's dedupe key (#813). A request for a waiting or delayed job is merged into its payload by a Lua script, with a cache bypass from any request winning. Any other request writes a Redis marker, where "1" (bypass) is set unconditionally and "0" only if empty, so no writer downgrades a bypass, and then adds the job. The add may be dropped because a poll's job won the race (#1196), so the marker is written first and `runParse` takes it with `GETDEL` before it parses. A deferred parse that took the marker throws `JobDeferral` carrying the merged payload, because retrying the original request would lose the bypass (#847). A request that lands after the take cannot reach the running job, and BullMQ removes the job id in `moveToFinished`, which no script of ours can join. So once the Worker reports the job completed, the worker re-adds it when a marker is waiting (#1197). The email and missing-source checks run after the take, or their marker would requeue the job forever. The TLA+ model in `__tests__/source-enqueue-model/` checks this protocol, and the `verify-source-enqueue` skill says how to bring it in line with a change here.

### The server asks the worker to queue a refresh, so only the worker runs the coalescing protocol

**Where:** `src/features/feeds/source-jobs.ts`, `SourceJobs.refresh()`, `createSourceJobHandlers()`; `src/features/feeds/routes/refresh.ts`, `postRefreshSourceHandler()`; `src/features/feeds/routes/subscribe.ts`, `postSubscribeHandler()`; `src/features/feeds/opml-import-service.ts`, `OpmlImportService.insertTree()`; `src/features/jobs/__tests__/source-jobs-integration.test.ts`

The job ids, the merge script and the pending-refresh marker above are a protocol the worker may one day implement in another language, so only worker code calls `enqueueSource`. A refresh click, a subscription with no snapshot or whose snapshot import failed, and an OPML import each add one `REFRESH_SOURCES` job with the source ids; an import sends every source it subscribed in that one job. The worker calls `enqueueSource` once per id with the defaults the server used (`manual`, cache bypassed).

The job has no job id, so nothing merges at this hop: N refresh requests are N jobs and then N `enqueueSource` calls, which coalesce onto the ParseSource job exactly as N server requests did. The TLA+ model already lets any of its requests call `enqueueSource` at any point against the poll, the run and the post-finish requeue, and it does not know who the caller is, so moving the caller changes no modeled step. The hop only moves each call later, after the route has answered. A job id at the hop was rejected: BullMQ would drop the later request, and a cache bypass queued behind a cache-eligible push would be lost unless the hop had a merge of its own.

The route answers once Redis holds the job, the same point at which it answered when the ParseSource job was added directly. A worker that stops inside the job leaves it stalled, BullMQ runs it again, and the repeated calls coalesce. A job that is lost after Redis took it, or whose `enqueueSource` fails in the worker and is logged and acknowledged (ADR 0012), loses the refresh as a lost ParseSource job did: the source keeps its schedule, a new source is due at once through `not_before`'s default and the next gather queues it, and a verified WebSub source is polled within a day. The one visible difference is that a Redis error inside `enqueueSource` used to fail the route with 500 and is now only logged; a Redis outage still fails the job add, and so the route.

Measured against Redis 7 with an idle worker, the refresh route spends 0.25 ms instead of 0.48 ms, and the ParseSource job is queued 1.9 ms after the route starts (p95 3.7 ms). The job is added LIFO, so a backlog of polls does not delay it, but it needs a free main-worker slot as the ParseSource job does, so on a saturated worker a refresh waits for two slots instead of one.

### Permanent redirects update the source; temporary ones live briefly in Redis

**Where:** `src/features/feeds/feed-parser.ts`, `FeedParser.parseUrl()`

A 301 or 308 is persisted onto the source's URL; a 302, 303 or 307 goes only into the short-lived `RedirectMap`. A mapping is written only when this fetch redirected, because the fetched URL is already substituted from the cache and refreshing on a non-redirect would keep a stale mapping alive forever. A failed Redis write is logged and ignored: that cache only saves a hop and must not cost this fetch's articles.

### Redirects are listed with SCAN, not KEYS

**Where:** `src/features/feeds/redirect-map.ts`, `scanPageHint`, `RedirectMap.getAllRedirects()`

This Redis also carries the job queue and the HTTP cache, and KEYS would block them for the whole walk. SCAN caps each page and serves them between pages. Duplicate keys across pages collapse in the result map, and missed concurrent additions are acceptable for an admin listing of a one-day cache.

### The first fetch corrects a source's home URL

**Where:** `src/features/feeds/feed-parser.ts`, `FeedParser`

A source created without a known homepage links to its feed's origin. The first fetch replaces that with the site the feed names, which is where the favicon refresh looks.

### The admin source list breaks sort ties on ascending id

**Where:** `src/features/feeds/source-data-service.ts`, `SourcesDataService.listAllSources()`

Every sortable column except url holds duplicates (`recent_failures` is 0 for almost every row). The tie-break is ascending id in both sort directions, so reloading the same sort never reshuffles tied rows.

### Drizzle quirks in SourcesDataService are worked around in SQL

**Where:** `src/features/feeds/source-data-service.ts`, `SourcesDataService.findSourceById()`, `hasSqlState()`; `src/features/feeds/__tests__/source-listing-integration.test.ts`

`findSourceById` counts subscribers with `$count`, a correlated subquery, so each caller stays at one round trip. A hand-written `sql` count must not name the outer `sources.id` directly: drizzle drops the table name from columns written at the top level of a single-table select's `sql` field, and a bare `id` resolves to `user_sources.id`. `$count` nests its filter, so the names stay qualified, and the listing test checks each source's count. `hasSqlState` looks for SQLSTATE 23505 or 23503 a few levels down the `cause` chain, because drizzle wraps the driver's error.

## Discovery, preview and subscribe

### The worker fetches, parses, maps and sanitizes for find, preview, subscribe and article reads

**Where:** `src/features/feeds/feed-requests.ts`, `FeedRequests`, `createFeedRequestHandlers()`; `src/features/feeds/routes/find.ts`, `src/features/feeds/routes/opml.ts`, `src/features/feeds/routes/preview.ts`, `src/features/feeds/routes/subscribe.ts`; `src/features/reader/routes.ts`, `GET /api/article`

A large feed held the API server's event loop for as long as it took to parse, rewrite and sanitize it, and every other user's request waited behind it. The server now keeps only the session, the per-user budget, plain database reads and writes, and the response; it hands the rest to the worker as a request on the dedicated `requests` queue (ADR 0012) and waits for the reply. `FeedRequests` is the server side, `createFeedRequestHandlers` the worker side, and the two compiled schemas for each request in between are the contract.

- **Find** sends the page URL. The worker fetches the page, scans it, and probes each candidate (`markWebSubAvailability`). Any failure except a deferral or a deadline comes back as `{ invalid: true }`, which the route answers as before with 400 "Invalid feed url".
- **Preview** sends the user and the feed URL. The worker fetches, parses and maps, saves the preview cache entry itself, so a large truncated feed never crosses to the server, and replies with the sanitized response body or the fetch failure, which the route classifies as before.
- **Subscribe** first asks the worker for the user's cached preview of the feed (`PREVIEW_SNAPSHOT`). The worker reads the preview cache and answers the preview's `link` and, when the preview is importable, the snapshot as a string, or nothing. The server stores that string as the subscription's snapshot without reading it, uses `link` as the home URL, and writes the subscription and its initialization lease. It then sends the stored snapshot back (`IMPORT_SNAPSHOT`), and the worker maps a truncated one in full, sanitizes and upserts. The snapshot format therefore lives only in the worker. A lookup that fails or that no worker answers in time counts as nothing cached, as a failed cache read did. Measured against Redis 7 with a 106 KiB snapshot, the lookup takes 2.5 ms (p95 3.9 ms) instead of the server's own 0.3 ms read. A reply of `{ invalid: true }` to the import fails the request with 500 as an unreadable snapshot did before. Any other import failure, a timeout included, queues the source for a fetch, as a failed inline import did.
- **OPML import** sends the uploaded file, capped at 1 MiB, base64 encoded. The worker decodes it, checks it is plain text, parses it and hashes it, and replies with the outline tree and content hash or which check failed, which the route answers as before with 400 "Invalid file" or "Invalid OPML". The server checks the size before sending and writes the folders and subscriptions itself, because that is plain database work, then sends the sources it subscribed back in one `REFRESH_SOURCES` job.
- **Article detail** sends content stored by an older sanitizer and returns what the worker answers. Nothing is written back; the next import of the article stores the current version.

A deferral or a deadline in the worker reaches the server as the same error (ADR 0012), so the central error hook answers 429 with `Retry-After` or 504 as it did when the server fetched. A request that no worker answers within `workerRequestTimeoutMs` (60 s, twice the HTTP client's deadline) is a 504 "This site isn't responding right now.", the same as a feed host that does not answer: during a rollout a new server can come up before any new worker, and the user can retry. An article whose stale content cannot be re-sanitized is also a 504, because returning it unsanitized is not an option.

### Outbound work on a user's behalf shares one per-user allowance

**Where:** `src/features/feeds/outbound-fetch-budget.ts`, `OutboundFetchBudget.consume()`

`HttpClient` is polite per host but not per user, and registration is open, so without a budget anyone could use the server as a crawler. Every route that does outbound work or adds a source row consumes from one budget of 30 requests per minute, before any outbound work and including a cache hit. The server consumes it before it queues the worker request, so a refused request costs the worker nothing. The `HttpDeferredError`'s `retryAt` comes from the counter's TTL, so the client learns when the window turns over.

### find suggests OpenRSS but never probes it

**Where:** `src/features/feeds/feed-requests.ts`, `createFeedRequestHandlers()`, `find`

For a page that advertises no feed, find offers the OpenRSS suggestion without fetching it. Probing would send the page address to openrss.org before the user chose to try it; previewing the suggestion is that choice.

### HTML scanning takes the first of repeated single-valued elements

**Where:** `src/features/feeds/html-scanner.ts`, `scanHtml()`

This matches the extension's `querySelector`, so the server and the extension read the same value.

### A preview is bounded, but subscribing imports the whole feed

**Where:** `src/features/feeds/feed-mapper.ts`, `previewArticleLimit`, `previewContentBytesLimit`, `previewItems()`, `mapFeedToPreview()`, `FeedPreview`; `src/features/feeds/feed-requests.ts`, `isImportableSnapshot()`, `completePreview()`; `src/features/feeds/routes/subscribe.ts`, `postSubscribeHandler()`

A preview is a sample the user waits for, and its reply passes through Redis, so items are bounded (50 articles, 512 KiB of body, at least the first article) before link rewriting. A truncated preview keeps the complete parsed feed and the post-redirect `finalUrl`. The worker hands subscribe the cached preview unchanged as the subscription's snapshot, and the worker's snapshot import has `completePreview` map it in full once, resolving relative links against `finalUrl` as every poll does; otherwise the first poll rewrites each article and read articles come back unread. Mapping in the worker is why the snapshot keeps the feed rather than the mapped articles. A truncated preview without its feed is not stored. The import is a plain upsert that keeps subscribe fast; if it fails, even after committing some batches, or the feed is missing, the source is queued for the worker. A server on the previous release accepts the new snapshot, which carries `feed` and `finalUrl` like a cache entry, but imports only its first 50 articles; the next poll brings the rest.

### Large feeds are bounded before mapping, and feed-level fallbacks are computed once

**Where:** `src/features/feeds/feed-mapper.ts`, `mapFeedToPreview()`; `src/features/feeds/xml-feed-parser.ts`, `parseRssFeed()`, `parseAtomFeed()`

Mapping and sanitizing every item runs on the worker's event loop while the user waits, so the item list is bounded first (#1031). Feed-level `url` and `authors` are resolved once and shared as plain values across items rather than recomputed per item.

### The preview cache serializes the parsed feed field by field and checks the URL

**Where:** `src/features/feeds/feed-preview-cache.ts`, `encodeFeed()`, `decodePreview()`, `previewWireSchema`

`encodeFeed` projects only the wire-schema fields (`parsedFeedWireSchema`), including authors, the CAP fields and item languages subscribe reads, dropping extra fields such as author email/url or enclosure byte length. The stored full feed is bounded by the HTTP client's 24 MiB body cap. A decoded preview whose `feedUrl` differs from the requested URL is discarded, so a key collision or hand-edited entry cannot return another feed.

### Preview cache failures degrade instead of failing the request

**Where:** `src/features/feeds/feed-preview-cache.ts`, `FeedPreviewCache.get()`, `FeedPreviewCache.save()`; `src/features/feeds/routes/subscribe.ts`, `postSubscribeHandler()`

A failed read is a miss, and subscribe queues the feed for the worker. Subscribe treats a `PREVIEW_SNAPSHOT` request that fails or times out the same way. A failed write is logged, because discovery already answered and the later subscribe would otherwise find nothing with no clue why.

### The parsed-feed schema comes in an open and a closed variant

**Where:** `src/features/feeds/feed-mapper.ts`, `parsedFeedSchemaWith()`, `parsedFeedSchema`, `parsedFeedWireSchema`

Mapping reads the same fields whichever parser produced the feed. `parsedFeedSchema` holds `Date`s and is open, because the XML library's objects carry more fields. `parsedFeedWireSchema` holds epoch milliseconds for the preview cache and is closed, so the cache rejects anything else.

### Subscribing retries once on a foreign-key violation

**Where:** `src/features/feeds/user-source-data-service.ts`, `addSourceToUser()`

`addSource` can return an orphan source that retention deletes before the subscription row is inserted, failing with SQLSTATE 23503. One retry creates the source afresh, so a rare race is not a user-visible error.

### A user can rename and refile a subscription but not repoint its feed

**Where:** `src/shared/contracts/requests.ts`, `updateSourceRequest`

`sources` rows are shared across subscribers (`sources_url_unique`), so editing the feed or home URL would repoint everyone's subscription. Name and folder live on the per-subscriber `user_sources` row and are editable. Changing the feed means unsubscribing and subscribing to the other URL.

### An email source is never fetched, but its subscription is still initialized

**Where:** `src/features/feeds/routes/subscribe.ts`, `postSubscribeHandler()`; `src/features/jobs/main.ts`, `MainWorker.runJob()`

A newsletter's articles arrive by mail and its address is not a URL, so parsing it would only record a failure and mark the source broken. Subscribe does not enqueue it but still runs the initialization lease with an empty body. A refresh request can still queue a job, and the worker drops ParseSource for an email source.

## Newsletter addresses

### A newsletter address is minted by the SPA and reserved before Subscribe

**Where:** `src/features/feeds/routes/newsletter-address.ts`, `postNewsletterAddressHandler()`; `src/shared/contracts/requests.ts`, `newsletterAddressRequest`; `src/shared/contracts/spa-routes.ts`, `PreviewRoute`

The user pastes the address into a sign-up form before pressing Subscribe, so mail, often the confirmation the newsletter waits for, can arrive first (#1116). Minting therefore creates the email source at once with `reservedBy` set, and that mail is stored instead of bounced; nobody sees it until the user subscribes, and once the address is a day old retention deletes its mail while nobody subscribes but keeps the address reserved. The extension asks the SPA's `/preview?newsletter` route to mint because the SPA knows the mail domain, which keeps the format in one place. Reserving an existing source leaves it as it is, whoever owns it, with the same answer, so the endpoint reveals nothing about the address.

### Only an address minted here can create a newsletter source, and it belongs to one account

**Where:** `src/shared/util/newsletter-address.ts`, `newsletterAddress()`, `isNewsletterAddress()`, `isMintedNewsletterAddress()`; `src/features/feeds/user-source-data-service.ts`, `addSourceToUser()`, `subscribe()`; `src/features/feeds/routes/subscribe.ts`, `postSubscribeHandler()`

A minted address only has to be unguessable and unique, and belongs to the account that created it. Only the minted format on this instance's mail domain may create a source, so no account can take `postmaster@` or another mailbox certificate authorities mail to validate the domain. Subscribe still accepts the dashed-UUID format older extensions mint; the reservation endpoint, called only by the SPA, accepts the current format alone. A subscription to an address reserved by another account, or to an unminted address with no source, returns `"refused"`, and the route answers it with the same 422 as a malformed target, so a refusal says nothing about the address.

### The reserving account's subscription is backdated to the source's creation

**Where:** `src/features/feeds/user-source-data-service.ts`, `subscribe()`

A subscription's `created_at` is where it starts seeing articles, and mail sent before the owner subscribed has to be readable, so the reserving account's subscription takes the source's `createdAt` and its unread count is recomputed at once. This also keeps the before-first-subscription retention rule off that mail. Feed subscriptions, and other subscribers of an older shared address, are not backdated.

### A newsletter links home to the app's public origin

**Where:** `src/features/feeds/routes/newsletter-address.ts`, `newsletterHomeUrl()`

A newsletter has no site of its own, so its home URL is this app: `publicOrigin` when `FEED_FATHOM_DOMAIN` is set, else the request's origin. Behind a proxy that rewrites `Host` the request's origin is the upstream address, so such deployments need the public origin configured.

## WebSub

### The WebSub callback is mounted outside the session check

**Where:** `src/features/feeds/routes.ts`, `createFeedRoutes()`

The hub calls the callback, not a signed-in reader. Inside `signedInRoutes` every verification and push would fail authentication.

### WebSub verification answers 404 for anything it cannot verify

**Where:** `src/features/feeds/routes/websub.ts`, `createWebSubRoutes()`

The spec makes 404 the way a hub learns a subscription failed or was deleted. Any other answer to an unknown token, wrong mode or mismatched topic leaves the hub retrying forever.

### The push body is capped while it streams in

**Where:** `src/features/feeds/routes/websub.ts`, `readCappedPushBody()`

A push replaces a fetch, so it may be as large as a feed body and no larger. The callback is unauthenticated and the signature can only be checked over buffered bytes, so the cap runs on the stream and abandons an oversized body mid-read; a declared `Content-Length` is checked but not trusted. Extends ADR 0003.

### A pushed body stays fresh for exactly the poll floor

**Where:** `src/features/feeds/source-jobs.ts`, `pushedBodyFreshMs`

The seeded body must outlive any normal backlog before the queued parse and no more, since a real fetch is the safe fallback. Tying it to `pollFloorMs` means a push never pulls the next fetch earlier than a poll would. Extends ADR 0003.

### A verified push goes to the worker, which seeds the cache and queues the parse

**Where:** `src/features/feeds/routes/websub.ts`, `createWebSubRoutes()`; `src/features/feeds/source-jobs.ts`, `SourceJobs.push()`, `createSourceJobHandlers()`

The cache entry's format and lock belong to the HTTP client the worker runs, so the server only checks the hub's signature, adds a `WEBSUB_PUSH` job with the source id and URL, the body in base64 and every request header, and answers the hub. It does not choose headers; `seedCache` keeps the ones it stores (ADR 0013). The body is capped as it streams in, so a job holds at most 24 MiB of body as 32 MiB of base64, and it is removed once handled. The worker seeds the cache when the body is not empty and queues the `websub-push` parse with `skipCache` unless the seed succeeded, the rule the route applied before. The hub gets its 2xx once Redis holds the job, as it did once the parse was queued, and a failed add is a 500 the hub retries. A job lost after that loses the push as a lost ParseSource job did, and the daily poll of a verified source catches up. With a 64 KiB push and an idle worker, the route spends 0.4 ms instead of 0.6 ms, and the parse is queued 2.8 ms after the route starts (p95 4.9 ms).

### WebSub needs a public origin, and hub failures never fail a fetch

**Where:** `src/features/feeds/websub-subscriber.ts`, `WebSubSubscriber`; `compose.yml`, `worker.environment.FEED_FATHOM_DOMAIN`

Without a public origin no hub can reach a callback, so an undefined `publicOrigin` turns WebSub off. Subscribing happens in the worker, not the server, so `compose.yml` passes `FEED_FATHOM_DOMAIN` to the worker too; without it WebSub is silently off. `subscribe` records a hub failure on the source instead of throwing, because an unreachable hub says nothing about the feed.

### The hub subscription request is accepted, not verified, and never follows redirects

**Where:** `src/features/feeds/websub.ts`, `requestHubSubscription()`

A 2xx only means the hub accepted the request; it must still GET the callback with a challenge, so this never marks a source verified. It sends `hub.verify=async`, deprecated since 0.4, because WordPress.com's pushpress hub rejects requests without it. It does not follow redirects, because the target is hub-controlled and following would be an SSRF surface. The request goes through `HttpClient.post`, so a hub's back-off arrives as a deferral, which counts as a failed subscribe rather than escaping into `parseSource`.

### Hub discovery reads atom:link and holds discovered URLs to the outbound policy

**Where:** `src/features/feeds/xml-feed-parser.ts`, `collectLinkRels()`; `src/features/feeds/websub.ts`, `scanFeedBodyRels()`, `resolvePublicUrl()`

Plain RSS often advertises its hub with `atom:link`, so both `link` and `atom:link` elements count. For an XML feed the first `hub` and `self` links come from the tree the feed parser already built, so the body is not parsed a second time, and markup inside an article's CDATA can never pose as the feed's hub. An HTML page has no such tree and is still scanned with `HTMLRewriter`. Hub and topic URLs come from feed content or headers, so they pass the same URL policy as every outbound request.

### Discovery probes candidates one at a time through the parse pipeline

**Where:** `src/features/feeds/feed-discovery.ts`, `markWebSubAvailability()`

The discovery list shows push availability before subscribing, so each candidate goes through the cached, rate-limited parse pipeline. Candidates usually share a host, and probed together they queue on its rate limit and the late ones read as having no hub (#909), so they run sequentially in found order. Each probe catches its own failure and a failed candidate comes back unmarked rather than dropped, so its error surfaces at preview instead of the feed vanishing.

### WebSub discovery is queued at subscribe time, unawaited, and only logs its failures

**Where:** `src/features/feeds/source-enqueue.ts`, `SourceEnqueuer.enqueueWebSubDiscovery()`, `discoverWebSubJobId()`; `src/features/feeds/source-jobs.ts`, `SourceJobs.discoverWebSub()`, `createSourceJobHandlers()`; `src/features/jobs/main.ts`, `MainWorker.runJob()`; `src/features/feeds/feed-parser.ts`, `FeedParser.discoverAndSubscribeWebSub()`; `src/features/feeds/routes/subscribe.ts`, `postSubscribeHandler()`

Subscribe queues a `DISCOVER_WEBSUB` job so a WebSub feed does not wait on polling for a later `parseSource`. It does so through a `REQUEST_WEBSUB_DISCOVERY` job that the worker turns into the `DISCOVER_WEBSUB` job, so the per-source job id stays in the worker. Discovery fetches and parses the feed, so it runs in the worker like every other fetch, as a plain job on the main queue rather than a request: nobody waits for its answer. The job carries only the source id, and the worker reads the URL and WebSub state when it runs, so a source that became verified meanwhile is not subscribed twice. Its id is per source, so repeated subscribes to a source while one is waiting queue it once. Subscribe does not await the enqueue and only logs its failure, as it only logged a failed discovery before. Failures in the job are only logged, since the article fetch alongside it reports fetch and parse errors. If the job is lost, a later poll re-discovers the hub, and `claimWebSubSubscribeAttempt` keeps it from subscribing twice.

### Pending subscriptions are retried daily under an atomic claim

**Where:** `src/features/feeds/websub-lease-policy.ts`, `shouldAttemptWebSubSubscribe()`; `src/features/feeds/websub-state-service.ts`, `claimWebSubSubscribeAttempt()`, `recordWebSubDiscovery()`

Subscribing again is idempotent at the hub, so retrying `pending` heals a verification the hub silently dropped; `verified` is live and `failed` was refused, so neither is retried. The claim is an atomic `UPDATE` that fails inside another attempt's cooldown, a day for a pending subscription, so no two hub requests race with different callback tokens. A retry keeps the pending token and secret so a hub verifying the earlier request still finds its callback. The flat daily retry is deliberate; counting attempts is the upgrade if a dead hub's daily POST starts to matter.

### A hub's lease is honoured only when it is a finite positive number

**Where:** `src/features/feeds/websub-lease-policy.ts`, `resolveLeaseSeconds()`

`hub.lease_seconds` is a query parameter and can be absent, empty, non-numeric, negative or infinite. Anything else falls back to one day rather than a lease that has already expired or never expires.

## Parsing and sanitizing

### A feed's root element decides its format, not the content type

**Where:** `src/features/feeds/feed-document.ts`, `feedRootPattern`, `feedFormat()`; `src/features/feeds/microformat-feed-parser.ts`

Valid RSS and Atom are often served as `text/html` (Hugo and WordPress output, header-rewriting proxies, static hosts guessing by extension), and handing XML to the microformats parser fails the source. The pattern looks past an XML declaration to the root element, because XHTML pages with microformats start with one too.

### FeedFathom's XML helpers wrap Bun.XML and refuse entity declarations

**Where:** `src/features/feeds/xml.ts`, `parseXml()`, `rejectXmlEntityDeclarations()`; `src/features/feeds/xml-feed-parser.ts`, `parseXmlFeedTree()`

Feed XML is parsed directly from `Bun.XML.parse(..., { compact: false })` in a single pass into plain `FeedMapperInput` objects via `parseXmlFeedTree`, sharing `rejectXmlEntityDeclarations` and `parseRepairingXml` with OPML parsing. The OPML helpers hide three quirks of the compact shape: `@`-prefixed attributes, a lone child collapsing to an object (`childElements`), and an empty element as a bare string. `Bun.XML` caps entity expansion at about 100 times the input, still gigabytes for a 24 MiB feed, so any DOCTYPE with an internal subset is refused; an external DTD such as RSS 0.91's is allowed and never fetched.

### repairXml fixes only what cannot change a well-formed parse

**Where:** `src/features/feeds/xml.ts`, `repairXml()`, `parseRepairingXml()`

It removes text before the first tag, characters XML cannot hold and anything after the root's end tag (a WordPress cache plugin appends a `<script>`), escapes a bare `&`, and decodes HTML named entities. CDATA and comments are left whole, an unknown entity or one decoding to markup (`&LT;`) stays escaped, and mismatched end tags are not repaired, since that means guessing structure. `parseRepairingXml` tries the original first and, if the repair also fails, throws the original error.

### parseXmlFeed projects RSS, RDF and Atom in one pass over Bun.XML

**Where:** `src/features/feeds/feed-document.ts`, `parseXmlFeed()`; `src/features/feeds/xml-feed-parser.ts`, `parseXmlFeedTree()`

Direct single-pass projection replaces `@rowanmanning/feed-parser` and `fast-xml-parser-shim`, avoiding wrapper allocations, redundant child walks, and a post-parse schema walk over lazy getters while preserving RSS 0.9/1.0/2.0, RDF, Atom 0.3/1.0, Media RSS, and CAP semantics. Entries in CAP scope get `cap` and a `language` (`xml:lang`, else NAAD's `language=en-CA` category, else ""), which `generateArticleGuid` uses. An entry with no body, such as every YouTube video, takes its Media RSS description formatted as HTML text.

### Every feed date goes through parseFeedDate, and a zone-less date is UTC

**Where:** `src/features/feeds/xml-feed-parser.ts`; `src/features/feeds/feed-date.ts`, `zoneOffsets`, `withExplicitZone()`, `parseFeedDate()`

`new Date` reads a zone-less date in local time, so hosts would disagree; such dates, and zone names outside the table, are UTC, because hours off beats falling back to ingest time. JavaScriptCore knows only RFC 822's names, so a table maps the names publishers write, with ambiguous ones read the usual feed way (IST is India, CST and AST North American). Dates ending in `Z` or an explicit numeric offset bypass the regexes and go straight to `new Date`, and the pattern keeps AM/PM with the time.

### RSS author markup is stripped before contact splitting

**Where:** `src/features/feeds/xml-feed-parser.ts`, `extractAuthorsWithoutMarkup()`, `parseContactString()`; `src/features/feeds/plain-text.ts`, `htmlTag`

Contact splitting breaks an RSS author or `dc:creator` as "Name <email>" and drops outer angle brackets, so markup (WordPress h-card plugins wrap `dc:creator` in a span) comes out as a fragment. When the raw text holds a tag, tags are stripped first over text-only `managingeditor`, `author` and `creator` elements; Atom's structured `<author>` has child elements and is not affected. `htmlTag` requires whitespace, `/` or `>` after the tag name, so `Jane <jane@example.com>` is not stripped as a tag.

### CAP fields are read in namespace scope, with lowercase local names and MeteoAlarm's spelling

**Where:** `src/features/feeds/cap-entry.ts`, `isCapNamespace()`, `buildCapAlert()`; `src/features/feeds/xml-feed-parser.ts`, `childContext()`, `readCapFields()`

An entry is in CAP scope when it or any ancestor declares the CAP namespace, even if a nearer declaration rebinds the prefix; entry guids depend on this. Names are lowercased with the prefix dropped, so lookups use names such as `areadesc`. MeteoAlarm spells `msgType` as `message_type`, so both are read.

### A CAP entry's guid also hashes its language, URL and title

**Where:** `src/features/feeds/feed-mapper.ts`, `generateArticleGuid()`

NAAD lists each alert once per language and per info block under one id, and the store keeps one article per guid. An entry carrying a `language` (set on every entry of a CAP feed and only there) gets a suffix hashed from its language, URL and title, so it survives neighbours changing and identical copies still collapse. Other feeds keep their guids.

### An article keeps at most 20 enclosures

**Where:** `src/features/feeds/feed-mapper.ts`, `maxEnclosures`, `mapEnclosures()`

A feed can list hundreds of media per item. The first 20 are kept, a deliberately simple bound rather than a smarter selection.

### JSON Feed is mapped by hand

**Where:** `src/features/feeds/json-feed-parser.ts`, `parseJsonFeed()`

JSON Feed 1 and 1.1 is a flat object with no grammar to parse, so a small field-renaming mapper is less code than a dependency.

### Article sanitization compiles the fixed allowlist over htmlparser2's tokenizer

**Where:** `src/features/feeds/extract-article.ts`, `extractArticle()`, `fastSanitize()`, `HtmlSanitizer`

FeedFathom's sanitizer policy is static (71 allowed tags, only 5 tags with allowed attributes, no `style` or `class` allowlists). A fixed-policy sanitizer with a plain-text fast path, zero-copy pass-through over unmodified HTML spans, bitmask tag lookup, and automatic fallback to a reusable `htmlparser2` `Tokenizer` produces identical output to `sanitize-html` without per-call option compilation, `Frame` allocations, or bundling `postcss` and `launder`.

The fast path finds raw-text end tags with regular expressions, which cannot see three htmlparser2 behaviours, so those inputs go to the tokenizer instead. htmlparser2 matches an end tag by OR-ing each code unit with 0x20, so `\x1c\x0f` reads as `</`. Inside `<title>`, a `&` right after a partial `</title` match is consumed without decoding. A raw-text end tag with no `>` before the end of input leaves its last code unit as text. A differential fuzzer found these as 1,632 of 2,000,000 random documents that differed from `sanitize-html`. After routing them to the tokenizer, 4,000,000 random documents and 52,914 truncated or edited real articles came out identical.

### The sanitizer resolves relative links in the same pass

**Where:** `src/features/feeds/extract-article.ts`, `resolveLinks()`; `src/features/feeds/feed-mapper.ts`, `contentBaseUrl`

Mapping used to resolve links with an `HTMLRewriter` pass and the sanitizer then parsed the same body again. The sanitizer already reads every `href`, `src`, `srcset` and `poster` it keeps, so it now takes the item's link as a base URL and resolves them as it emits them: one parse per article instead of two. It resolves after decoding entities, so `&#106;avascript:` is seen as a script URL and dropped rather than turned into a relative link, and it resolves exactly the attributes it outputs, where the separate pass parsed malformed markup differently and could throw on it. Text re-sanitized from an `<iframe>` gets no base URL, as the old pass never looked inside raw text either. On the golden feeds the output is byte-identical.

### Sanitized links always get rel="noopener noreferrer"

**Where:** `src/features/feeds/extract-article.ts`, `extractArticle()`, `emitSanitizedAttributes()`

`allowedAttributes` lets `rel` through without a safe value, and some content (email articles) has no base URL to resolve its links against, so `rel="opener"` could re-enable `window.opener`. The safe value is forced on every link rather than detecting `target="_blank"` and its case variants.

### Sanitized images load lazily unless the feed said otherwise

**Where:** `src/features/feeds/extract-article.ts`, `extractArticle()`, `fastSanitize()`, `HtmlSanitizer`

An image-heavy article would otherwise fetch every image on open. Lazy loading works in the reader's overflow scroller because a clipped image is not intersecting the viewport. A feed's `loading="eager"` is kept: the sanitizer bounds content, it does not overrule the author.

## Favicons

### The favicon gather covers every recently fetched feed, iconless ones first

**Where:** `src/features/feeds/source-data-service.ts`, `getSourcesDueFaviconRefresh()`; `src/features/feeds/favicon-refresher.ts`, `faviconGatherIntervalMs`, `faviconGatherWindowMs`

Favicons refresh daily. Every feed fetched since the previous gather, plus an hour for a late poll, gets a job whether or not it has an icon; most are answered from the HTTP cache, and a dead feed stops costing provider requests. Email sources are skipped because the app's own icon would replace the mail glyph. Iconless sources sort first, because on a cold run those are the ones a person sees missing.

### Favicon deferrals are bounded by a horizon and a backstop

**Where:** `src/features/feeds/favicon-refresher.ts`, `faviconDeferralHorizonMs`, `faviconRefreshBackstopMs`, `FaviconRefresher.refreshFavicon()`

A provider block is waited out for at most two hours from the block itself, which covers the common hour-long Retry-After, and a longer block counts as a miss, so a provider answering 429 forever cannot hold back every icon. The rate limiter's own pacing always clears, so it neither starts nor counts against the horizon, and a job that waited hours in the queue still waits out a late short block instead of downgrading icons. Past the backstop (the gather interval minus four hours) after a job's first run every deferral is a miss, so each job frees its jobId before the next gather.

### Deferred favicon refreshes take one slot per provider host

**Where:** `src/features/feeds/favicon-refresher.ts`, `reserveSlotScript`, `FaviconRefresher.reserveSlot()`, `FaviconRefresher.enqueueRefreshes()`

Refreshes are enqueued with no delay because most hit the HTTP cache. Every refresh asks the same provider hosts and the limiter allows one background request per host per interval, so jobs woken together would each re-defer the others, about N²/6 runs for N sources (#1087). A deferred job instead queues for a slot of its own, one per interval plus slack, in the queue of every host that deferred it, so a block on one provider does not hold back jobs waiting only on others. Pacing is told apart from an origin's 429 by type, because a `Retry-After` shorter than the interval would otherwise defer forever, and the reservation is one Lua script so it is atomic across workers.

### A favicon refresh keeps a stable job id and a low priority

**Where:** `src/features/feeds/favicon-refresher.ts`, `FaviconRefresher.enqueueRefreshes()`

The jobId is `REFRESH_FAVICON-<sourceId>`, so the next gather's add does not reset a refresh still delayed by Retry-After. Priority 10 keeps a large favicon run behind the unprioritized ParseSource, Cleanup and GatherJobs jobs, which BullMQ runs first.

### Favicon providers are queried together, with unavatar as a last resort

**Where:** `src/features/feeds/favicon-refresher.ts`, `FaviconRefresher.refreshFavicon()`, `FaviconRefresher.bestFavicon()`

gstatic, favicon.im and DuckDuckGo are queried concurrently, and the smallest valid image meeting the target size wins, else the largest. unavatar.io allows 25 requests a day, so it is asked only when every primary really missed; one deferred inside the horizon has not, and makes the caller defer unless the best answer is exactly the target size. `homeUrl` is URL-encoded so `?` or `&` cannot leak into gstatic's query; favicon.im gets a bare domain and `throw-error-on-404=true`, or an unknown domain gets a generic SVG that outranks every real icon below 64 px.

### A deferred favicon refresh only fills a missing icon

**Where:** `src/features/feeds/favicon-refresher.ts`, `FaviconRefresher.refreshFavicon()`

While a provider that may hold a better icon is deferred, the best result so far is stored only when `hasFavicon === false`. A stored icon is never replaced by a possibly smaller one, but an iconless source shows something while it waits.

### Favicon candidates are measured from their bytes

**Where:** `src/features/feeds/favicon-selection.ts`, `imageDimensions()`

Providers return error placeholders, such as an HTML 404 page or HTML-escaped SVG markup, under a 200 status and a plausible image type. `imageDimensions` reads magic bytes and markup and rejects anything it cannot measure, so such a page is never stored as a favicon.

### Favicon normalization never loses an icon and refuses huge canvases

**Where:** `src/features/feeds/favicon-normalization.ts`, `normalizeFavicon()`

Any failure in decode, resize or re-encode returns the original bytes. A source claiming more than 4096×4096 pixels is refused through `maxPixels` before Bun.Image allocates.

### ICO frames are chosen by the size rule and rebuilt as 32-bit BMPs for Bun.Image

**Where:** `src/features/feeds/favicon-normalization.ts`, `icoFrame()`, `bmpFromIcoFrame()`

`icoFrame` uses the provider-selection rule (exact size, else smallest larger, else largest; higher bit depth on a tie), and a PNG frame passes as-is. Bun.Image decodes only 24- and 32-bit BMPs and drops alpha without a BITMAPV4HEADER mask, so each headerless DIB (height covering the XOR image plus AND mask, palette at 8 bpp or less, bottom-up rows padded to 4 bytes) is expanded to BGRA behind a V4 header with positive height. Only 32-bit frames with non-zero alpha keep their own; the rest take transparency from the AND mask (1 is transparent).

### Favicons are served sandboxed and cached privately forever under a content fingerprint

**Where:** `src/features/feeds/routes/favicon.ts`, `getFaviconHandler()`; `src/features/feeds/user-source-data-service.ts`, `getUserSources()`; `src/features/reader/routes/tree.ts`, `getTreeHandler()`

The handler drops media-type parameters and refuses anything but `image/*`, but the `sandbox` CSP is what stops an SVG opened directly from running script in the app origin. The response is `private` because the route is behind the session cookie, and `immutable` for a year because the tree puts `md5(favicon)` in the URL as `?v=` (#902), so the URL changes exactly when the icon does. A source with no fingerprint gets `null` rather than a bare `/api/favicon/:id` that would 404 on every load.

## Folders and OPML

### Folders come back ordered by name

**Where:** `src/features/feeds/folder-data-service.ts`, `FoldersDataService.getUserFolders()`

The dashboard renders folders in arrival order, and an OPML export of an unchanged tree should be byte-identical. A rename is an UPDATE that writes the new row at the end of the heap, so an unordered select would move it to the bottom.

### OPML import merges into one level of folders and only adds what is missing

**Where:** `src/features/feeds/opml-import-service.ts`, `OpmlImportService`

`user_folders` has no parent, so a nested OPML folder lands in the top-level folder of the same name. A feed the user already subscribes to keeps its folder and name.

### OPML import is lenient about empty bodies and malformed outlines

**Where:** `src/features/feeds/opml-parser.ts`, `parseOpml()`, `processOutlines()`

An empty `<body/>` parses to a string, and is a valid file that yields no subscriptions rather than an error. A malformed outline is skipped and the rest still imports.

### OPML titles get exactly one HTML decoding pass after XML decoding

**Where:** `src/features/feeds/opml-parser.ts`, `processOutlines()`; `src/features/feeds/plain-text.ts`, `decodeHtmlReferences()`

Readers that store titles HTML-escaped export them escaped again (`&amp;#39;`). Feed titles get one character-reference pass, so OPML titles get the same. Tags stay as text.

`decodeHtmlReferences` decodes with `entities`, which is faster, except for text containing a numeric reference in the surrogate range (`0xD800`–`0xDFFF`) or `0x10FFFF`, which goes to `html-entities` as the feed parser used to. Over all numeric references the two disagree only there: `html-entities` turns a surrogate code point (`&#xD800;`) into that lone surrogate and `&#x10FFFF;` into U+FFFD where `entities` gives U+FFFD and U+10FFFF respectively, and feed titles, item text and OPML titles must decode as they did before.

### OPML export is serialized by Bun.XML from an explicit node tree

**Where:** `src/features/feeds/opml-export.ts`, `buildOpml()`, `outline()`; `src/features/feeds/xml.ts`, `xmlSafeText()`

Bun.XML escapes every node and refuses ill-formed output, so a title with `&` or `<` cannot produce a file other readers reject. The explicit node shape keeps `<head>` before `<body>` as an array rather than relying on key order, and the XML declaration is prepended as text. `stringify` throws on C0 controls other than tab, newline and carriage return, U+FFFE, U+FFFF and lone surrogates, which titles pick up, so `xmlSafeText` drops them (`\p{Surrogate}` under `u` matches only lone ones) rather than failing the whole export. Outlines write `title` beside the required `text` because readers disagree on which they read, and `type="rss"` so a type-only reader does not take a feed for a folder.

### OPML export leaves out newsletter subscriptions

**Where:** `src/features/feeds/routes/opml.ts`, `subscriptionTree()`

A newsletter's URL is an address this instance routes mail for. Imported anywhere else it is a feed no reader can fetch and nothing will ever deliver to.

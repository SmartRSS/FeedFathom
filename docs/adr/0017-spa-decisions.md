# 0017 — SPA: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Talking to the server

### Unknown response fields are dropped, not rejected

**Where:** `src/spa/api.ts`, `api()`, `Value.Clean`

The service worker serves its cached shell first, so pages still running the previous bundle receive responses from a newer server. A field this bundle does not know is cleaned away before validation. Rejecting it would break every open tab after a deploy that adds a field.

### A slow GET races a second copy after one second

**Where:** `src/spa/api.ts`, `raceGet()`, `raceGetAfterMs`

Cloudflare sometimes holds a request for seconds to a minute before it reaches the origin, which answers in milliseconds, and a copy sent meanwhile usually takes another path. A GET still waiting after one second sends a second copy; the first answer wins and the other is aborted. Only GETs race, because repeating a write could apply it twice, and a caller whose GET makes the server fetch another site turns the race off so that site is not fetched twice.

### A reader sees one plain sentence; statuses and raw reasons go to admin details

**Where:** `src/spa/api.ts`, `messageOf()`, `ownFailure()`, `InvalidResponseError`, `failureDetails()`

A failure that is FeedFathom's own (a response this bundle cannot read, or a 5xx the server sent itself) shows a fixed "server ran into a problem" sentence. A 504 with a readable error is not the server's own: it means the server's request to a feed site timed out, and its sentence says so. Any other `Error` carries its own sentence, and `fallback` covers non-Error throws. The HTTP status and raw reason appear only in an admin's details, and `InvalidResponseError`'s message names the path and parse failure for the console and tests.

### Network failures become one sentence in one place

**Where:** `src/spa/api.ts`, `unreachable()`

A request that never reaches the server rejects with a browser-specific `TypeError` ("Failed to fetch" in Chrome, "NetworkError when attempting to fetch resource" in Firefox). It is replaced once here, where every call passes, with "FeedFathom can't reach its server", and the original stays as the `cause` for an admin's details.

### A caller's AbortError reaches it unwrapped, but only while its signal is aborted

**Where:** `src/spa/api.ts`, `isCancellation()`

Callers abort superseded requests and need the `AbortError` itself to tell a superseded request from a real failure. The check requires the caller's signal to be aborted, so a genuine failure that merely coincides with a later abort still surfaces as a failure.

### loadTree tells a superseded request from a failure by the error itself

**Where:** `src/spa/dashboard.tsx`, `loadTree()`

A failure counts as superseded only when it is an `AbortError` caused by this request's own signal: a genuine error must propagate even if another `loadTree()` started at the same time, and a controller may be aborted after its fetch resolved while parsing or validation throws for an unrelated reason. A superseded call defers to the shared in-flight promise rather than the `tree` signal, because `abort()` settles before the replacement's round trip does.

### Every article DELETE carries a trace of the input that caused it

**Where:** `src/spa/delete-trace.ts`, `installDeleteTrace()`, `deleteTrace()`

On 2026-10-20 two articles were deleted 0.53 s apart, 17 s after the user's last click, and nothing could say what sent them. Each article DELETE carries the triggering event and this tab's recent input, and the server logs both, so a delete with no trigger or no recent click or key identifies itself. Input is recorded in the capture phase so nothing the page stops is missed; only key names are kept (a printable key is recorded as `char`) so the trace never holds typed text; and a random tab id separates tabs that share one session. The header stays under 3000 characters to pass every proxy, dropping the oldest input first, and non-ASCII characters are replaced because `fetch` throws on a non-ASCII header value.

## Deploys, boot and offline

### How the page detects a new deploy

**Where:** `src/spa/main.tsx`, the `controllerchange` and `message` listeners

A `controllerchange` counts as an update only when the page's bundle already names the controlling worker: a page loaded from a new shell under the previous worker is waiting for exactly the worker it registers, and that takeover is not an update. The worker serves a cached shell first and posts `shell-updated` when the server's shell names different assets, because a deploy that changes only the bundle never fires `controllerchange`.

### A new deploy applies on the next page hide, without a prompt

**Where:** `src/spa/main.tsx`, the `visibilitychange` listener and `markUpdatePending()`

When a new deploy is detected, the page reloads the next time it is hidden, unless a dialog is open or a form has unsent input. By then the worker has cached the new shell and its assets, so the reload is served from cache and the user returns to the new version.

### An update reload restores the tab whatever the remember setting says

**Where:** `src/spa/reading-session.ts`, `reloadForUpdate()`, `ReadingSessionStore.saveBeforeReload()`, `takeSnapshot()`

The user did not ask for a reload that applies a new deploy, so it resumes where the tab was. The page dispatches `UPDATE_RELOAD_EVENT` so the dashboard writes a full snapshot, and a sessionStorage flag tells the next boot to restore it. With the remember setting off, that snapshot goes to sessionStorage only and is removed once read, so it survives this one reload and never reaches a later launch.

### The service worker file differs between production and development

**Where:** `src/spa/main.tsx`, the service worker registration (`VITE_SW_FILENAME`)

`bin/build-spa.ts` bundles the worker and names it for a production build, passed in as `VITE_SW_FILENAME`, and it registers as a classic worker. Vite's dev server serves the source `/sw.ts` as a module worker instead, which only Chromium-based browsers register.

### Routes other than the dashboard load as separate chunks

**Where:** `src/spa/main.tsx`, the `lazy()` route components and the `Errored` boundary

Every route except the dashboard loads its chunk on first visit, so launching the dashboard never downloads or parses them (#880). The service worker caches a chunk once fetched, so a route never visited while online cannot open offline. The `Errored` boundary around the routes covers that case and a deploy that removed the old build's chunks.

### The tree preload runs on exactly the routes that show the panes

**Where:** `src/spa/routes.ts`, `treePreloadPaths`, `showsPanes()`; `src/spa/vite.config.ts`; `src/spa/index.html`

The page preloads `/api/tree` only for paths that render the dashboard panes: the service worker starts it, or, for a page no worker controls yet, `index.html`'s inline script does, which `vite.config.ts` fills in from this regex. A route that shows the panes but misses the preload costs an unpreloaded tree request at boot; an extra route spends a request nothing reads, or draws a 401 before sign-in. A route test checks the regex agrees with `showsPanes()`.

### Boot paints the cached tree only if it beats the network

**Where:** `src/spa/dashboard.tsx`, `cachedTree()` and the boot sequence

Only a page the service worker controls asks for `?cached`, since only the worker answers it; `only-if-cached` keeps the request off the network when something else answers, such as a worker from before #989 that forwards it unchanged. The cached tree paints only if it arrives before the fresh one, which then replaces it through `loadTree()`; the identity of the `tree()` array tells whether the fresh one already landed. Everything that trusts the tree (sign-in state, the poll's unread baseline, session restore) waits for the fresh answer, so a 401 still routes to sign-in and the swap never reads as new articles (#989).

### The offline removal queue lives in IndexedDB and the page clears it on logout too

**Where:** `src/spa/mutation-queue.ts`, `QueuedMutation`; `src/spa/sw-protocol.ts`, `forgetAccountData()`

The service worker queues removals made offline in IndexedDB, so the queue outlives the worker. The page also clears it on logout, for a logout the worker does not see. `QueuedMutation.account` is optional because entries queued before #982 have no account, and a replay drops them.

### Every request names the account the page shows

**Where:** `src/spa/api.ts`, `requestSession()`, `forgetAccount()`, `requestInit()`; `src/spa/dashboard.tsx`, `loadSession()`, `sessionRetryFirstMs`, `sessionRetryMaxMs`; `src/spa/main.tsx`, `handleUnauthorized()`

A sign-in in another tab replaces the session cookie under an open page, which then still shows the old account. Any change it sends, not only a removal, would land on the new account (#1209). So `api()` names the account from the last `/api/session` answer in `X-FeedFathom-Account` on every request, and the server refuses a request for another account with 412 (ADR 0009). The page is the one place that knows which account it shows, and neither the page nor the worker can read the session cookie. The session request itself names no account, because its answer is how the page learns the account. A sign-in or logout from this page forgets the account, so the next page does not send the previous account's name before its own session answer arrives. A request sent before the first answer names no account: online the server applies it as it always did, and offline the worker refuses to queue a removal without one (ADR 0018).

The dashboard retries a failed session request, waiting one second and then twice as long each time, up to one minute, until it succeeds (#1210). Without the retry, one failed request would leave the page naming no account until it reloaded. Asking for the session again before each request would instead put a round trip in front of the first requests of every load. The retry stops when the dashboard unmounts.

When the server answers 412, the page reloads and starts over as the account that is signed in now. Reloading only the tree would show the new account's feeds beside the old account's session answer, and every later request from the page would be refused.

### Offline sync is paced by tree loads, at most once a minute

**Where:** `src/spa/offline-sync.ts`, `OfflineSyncPacer`, `createOfflineSync()`

Offline reading (#992) tells the worker which unread bodies to keep. Tree loads pace it: the stream, the poll, marking read and removing all reload the tree. A sync runs at most once a minute, in idle time, and is retried when the tab, the network or the worker comes back, since a sync may have stopped short when it went.

### Turning offline reading off tells the worker to drop its copies

**Where:** `src/spa/offline-sync.ts`, the module-level `createEffect` on `offlineUnread`

The service worker cannot read localStorage, so the dashboard sends it the sources with unread articles. Switching offline reading off, in this tab or another, posts an empty list, and the worker drops what it kept.

## Session restore

### Session restore names rows by id and degrades to a normal boot

**Where:** `src/spa/dashboard.tsx`, `listState()`, `restoreFrom()`, the reader-scroll effect; `src/spa/session-restore.ts`

The snapshot is read before any await, so a reload restores the state the tab left in rather than one a faster boot wrote; the preview route skips it so the reader does not come forward over Discover; and nothing is recorded before a list exists, or it would overwrite the snapshot boot is about to restore. Rows are named by id, since an index means nothing once the list is refetched; the tree is the source of truth, so a snapshot naming a deleted source is dropped and boot proceeds normally, and re-selecting the node runs the one article fetch boot would run anyway. Reader scroll is stored as a ratio because content height varies, and applied once the pane shows, because a hidden reader measures zero. The list shows its skeleton while the tree loads with nothing selected, so a restored feed's rows exist to take focus.

### A session restore suppresses recording and the scroll-past observer

**Where:** `src/spa/session-restore.ts`, `SessionRestore`

While a restore is in progress nothing records over the stored snapshot and the scroll-past observer stays off, so the programmatic scroll that applies it is never taken for the user scrolling past rows (#718). A plain `#active` field mirrors the `restoring` signal because a signal write shows in its reads only after Solid's next flush, and `select()` cancels and records in one go. After `finish()`, the observer's first pass only takes note of the rows on screen; they become eligible once they leave and re-enter the viewport.

### The reading session is one versioned blob in two storages

**Where:** `src/spa/reading-session.ts`, `parseReadingSession()`, `ReadingSessionStore`

Session restoration (#718) stores one versioned JSON blob under one key in sessionStorage (survives a reload) and localStorage (survives across days); reading prefers sessionStorage for the freshest snapshot and falls back to localStorage in a new tab. The page has no IndexedDB store of its own, since the worker's removal queue owns the only one and a size-capped blob is enough. The blob is checked by hand rather than with a schema library, so a foreign or truncated value reads as `undefined`, the normal boot path, and a version mismatch drops it (a future v2 would read v1 there and reshape it). The list-context fields (`anchorId`, `focusedId`, `loadedCount`, `search`, `selectedIds`) are optional so a snapshot written before they existed still restores the article alone.

## Marking read and deleting

### Marking read is manual by default

**Where:** `src/spa/preferences.ts`, `markReadPolicy`

The default mark-read policy (#714) is manual: the app's workflow is delete-as-you-read, and marking articles read behind the user's back would empty the unread badge for someone who never asked for read state. The on-open and on-scroll-past policies exist because readers disagree strongly. `markReadOnOpen`, the boolean that preceded #714, seeds the fallback so a stored "true" survives the rename.

### Marking read on open applies only in the All view

**Where:** `src/spa/dashboard.tsx`, `selectRows()`

Under the on-open policy an article is marked read only when the filter is All. In the unread view, marking on open would pull the row out from under the person reading it.

### Marking read is optimistic, local, and only the explicit action announces

**Where:** `src/spa/dashboard.tsx`, `markArticlesRead()`; `tests/browser/spa.spec.ts`

A mark is applied locally and, being reversible, a failure resyncs rather than explaining itself. A newly read row does not belong in the unread view (nor an unread one in the read view), so it is dropped locally; re-asking the server would flash the skeleton over a list that is already correct, and only a change of question (selection or filter) requests the list again. Only the explicit action passes an announcement; on-open and scroll-past marks happen per row as the reader moves and would chatter.

### Mark read on scroll past is built only when the policy asks for it

**Where:** `src/spa/dashboard.tsx`, the `observeScrollPast` effect in `Dashboard`

The observer exists only under the `on-scroll-past` policy, so other readers pay nothing, and it is rebuilt whenever the list changes because it watches the rows that render put in the DOM (#714). It stays off while a session restore scrolls the list (#718). Already-read rows and the selected row are never queued: re-marking the row being read would pull it out of the unread view, and the selection, not the opened article, names that row because the article fills in only after its body arrives.

### Scroll-past marking uses a one-second dwell and one-second flush spacing

**Where:** `src/spa/scroll-past.ts`, `DWELL_MS`, `DEFAULT_FLUSH_EVERY_MS`

A row must stay at least 50% visible for about a second to count as read under the scroll-past policy (#714). That is long enough that a row flashed past while jumping around is not marked, and short enough that a steady scroll never queues more than one request's worth of rows. Leaving the viewport cancels a dwell, so the row starts over when it returns.

### A scroll-past batch waits for rows still dwelling, for at most one window

**Where:** `src/spa/scroll-past.ts`, `ScrollPastQueue`, `readyAt()`

A batch leaves at the later of two times. Spacing: never sooner than one window after the last flush, which keeps a long scroll to one request per window. Filling: rows enter the viewport one by one as the scroll carries them, so their dwells complete milliseconds apart, and the batch waits for any row still mid-dwell or it splits into many requests; but it waits only one window from its first pending row, because a scroll that keeps feeding in rows always has one mid-dwell. Fast machines hide the splitting; CI exposed it.

### Stopping scroll-past observation flushes finished rows

**Where:** `src/spa/scroll-past.ts`, `observeScrollPast()`

The returned stop function sends the rows that had finished dwelling, because a change of list or an unmount must not drop rows the policy already counts as read. With `passiveFirstPass`, rows visible when observation starts only take note; they become eligible once they leave and re-enter the viewport.

### Deleting articles is optimistic and rolls back only into the list it left

**Where:** `src/spa/dashboard.tsx`, `removeSelected()`, `removeNode()`

The DELETE is sent first so network time overlaps the local work, then the rows leave and their unread counts come off the badges without waiting for the round trip. On failure the rows go back only if the same list is still on screen (its signal is not aborted): a list loaded since already shows what the server holds, and clearing the list, as removing its source does, is what stops a pending delete from rolling back. The tree reload undoes the optimistic counts either way.

### Opening the original does not mark the article read

**Where:** `src/spa/dashboard.tsx`, `openOriginalInNewTab()`

Deleting, not reading, is how this reader clears articles, so opening the original page in a new tab has no mark-as-read side effect.

### The mark-read button shows the state it will produce

**Where:** `src/spa/articles-pane.tsx`, the mark-read toolbar button

A check-circle means read and a dot-circle means unread; the glyph shows the state the action produces, so it flips with the action (#766). This follows feed-reader convention rather than email's, so neither icon reads as a mail action.

## The article list and search

### The article list cursor is the last row received, and in-flight work belongs to its list

**Where:** `src/spa/article-list.ts`, `Cursor`, `ArticleList`

The paging cursor is the last row of the last page received, not the last row still on screen: deleting the whole page would otherwise leave no row to take a cursor from, which is exactly when the next page is wanted. Its `publishedAt` places it in the offline list once it has left the kept rows (#992). Starting a new list abandons whatever the old one has in flight, and `#loadingMore` is the list's own `AbortController` rather than a flag, so a page abandoned by a feed, filter or search change neither blocks the new list's next page nor clears its loading state when it settles late.

### Paging is driven by scroll position, and short lists top themselves up

**Where:** `src/spa/dashboard.tsx`, `loadMoreArticles()`, `topUpArticles()`

The list is the scroll container in both layouts, and on mobile the pane is `column-reverse`, so a "load more" control after the list would render above it. Because the scroll handler is the only thing that asks for the next page, a list too short to scroll could never ask (select all, delete, and the pane is empty with pages unread). The distance threshold reads true for a list that does not overflow, so `topUpArticles()` calls the same function after the render that shortened the list.

### The first row opens on its own only beside a visible reader

**Where:** `src/spa/dashboard.tsx`, list loading in `select()`; `src/spa/feed-discovery.tsx`, `preview()`

Beside a visible reader the first row opens at once. Where the reader is hidden until an article is opened, nothing is selected until the reader asks, while the keyboard cursor and selection anchor still start on the first row. Discover's preview list follows the same rule.

### Each list row has its own selection flag

**Where:** `src/spa/dashboard.tsx`, `createRowFlags()`

A selection change notifies only the rows whose flag flips, not every row of a list that infinite scroll grows without bound.

### Search is a server-side mode over the list

**Where:** `src/spa/dashboard.tsx`, `runSearch()`, `exitSearch()`, `select()`, `searchTerms`, `activeSearch`

Extends ADR 0006. Search does not filter what is loaded: the terms go to the server, which pages by the same keyset cursor (#697). `searchTerms` is what is typed and `activeSearch` what the server was last asked. Entering search switches the filter to All once; re-running terms under a filter the user then chose keeps that choice. Picking a feed empties the box, and leaving search starts the list over as `select()` does, so a response that lands after the clear cannot repopulate the emptied list (#815).

### The article search and filter controls

**Where:** `src/spa/articles-pane.tsx`, `ArticlesPane`

The filter dropdown has a visible "Show" label, because among icon buttons a bare dropdown reading "Unread" looks like a status; as a view option it sits right of the spacer beside the reader pane's display-mode dropdown (#767). Search has its own row because the toolbar has no room to show what was typed, and it is a form so Enter submits and the browser draws its clear affordance; it runs on submit, not per keystroke, because every query is a full-text scan on someone's home server (#697). Both controls are disabled where a selected feed or folder lists nothing, except that a caught-up feed keeps the filter (All reaches its read articles) and search stays enabled with nothing selected (it answers across every subscription).

### An empty search result says "no matches"

**Where:** `src/spa/article-list.ts`, `emptyListState()`

Search answers across every subscription, so an empty result means no such article, not "all caught up", and the prompt to pick a feed would be wrong advice.

### Hiding a filter or search box clears what it held

**Where:** `src/spa/dashboard.tsx`, the box visibility effects in `Dashboard`; `tests/browser/spa.spec.ts`, "hides the feed filter and article search boxes independently"

Each box is one row of a pane with little height to spare, so each can be hidden. An invisible tree filter would keep narrowing the tree, and hidden search results would have nothing on screen to explain or undo them, so turning either box off also clears its filter or exits search.

### A failing feed's notice waits a day and shows only on the feed itself

**Where:** `src/spa/articles-pane.tsx`, `failingNotice()`

A failing feed that still has articles lists them, with a notice above once it has gone a day without an update; a shorter outage is usually fixed by the next poll. The notice appears only when the feed itself is selected, not under Today or its folder.

### Articles dated in the future group under Today

**Where:** `src/spa/date-group.ts`, `getDateGroup()`

Everything from the start of today onwards, later dates included, is "Today". An article dated ahead of the clock (clock skew, a publisher's time zone) belongs with the newest, not in a second "Within the Last Week" group above Today.

### ISO dates render in fixed UTC

**Where:** `src/spa/format-date.ts`, `isoDateTime()`

The ISO date format shows UTC with no offset column. An offset invites the question whether a time is the user's or the server's, and every API timestamp is an absolute instant, so one fixed frame is unambiguous. In ISO mode, "today" in a list row is the UTC day.

### Date formatters are built once at module load

**Where:** `src/spa/format-date.ts`, `localeDateTime` and the other `Intl.DateTimeFormat` constants

Constructing an `Intl.DateTimeFormat` costs about 30 µs and `formatDate()` runs for every article row, so the formatters are created once. The locale and time zone therefore resolve at load, and a change to either during a session shows only after the next page load.

### Off-screen article rows keep a rendered row's exact height

**Where:** `src/spa/style.css`, `.article` (`content-visibility`, `contain-intrinsic-block-size`) and `.article .title`

Rows off screen skip rendering (#990), so their placeholder height must match a rendered row exactly, including rows with a blank title and byline. Any error is multiplied by every row above and makes a restored `scrollTop` and the paging threshold drift.

### Read state in the article list is shown by weight

**Where:** `src/spa/style.css`, `.article.read .title`; `tests/browser/spa.spec.ts`, "tells read from unread by weight, not only colour"

Colour cannot carry read state: forced-colors mode replaces stylesheet colours with the system palette, and a selected row already has to set a read title back to the selected text colour or contrast drops under 1.5:1. Font weight survives both, as the tree already relies on for sources with unread articles.

## Reading articles

### Reader documents come only through the extension, never the backend

**Where:** `src/spa/extension-reader.ts`, `createExtensionReaderBridge()`; `src/spa/reader-content.ts`, `ReaderOptions.bridge`

Reader mode gets the full article HTML only through the extension bridge: SPA window, content script, extension background, a direct fetch by the extension, and a validated response. Reader documents are never proxied through the FeedFathom backend, and the bridge answering at all proves the extension is configured for this SPA origin.

### Reader extraction libraries load only when Reader mode is used

**Where:** `src/spa/reader-content.ts`, `ReaderState.open()`; `src/spa/reader-extraction.ts`

Readability, article-extractor and DOMPurify are needed only in Reader mode, so `reader-extraction.ts` is loaded with `import()` on first use and stays out of the main chunk. Sessions that only use Feed mode never download them, and a failed load falls back to Feed mode.

### Reader extraction has size and element budgets

**Where:** `src/spa/reader-extraction.ts`, `assertWithinBudget()`, `exceedsElementBudget()`, `extractWithReadability()`

Extraction runs on the main thread, so it must stay short enough that a click to switch away is still answered; pages over the byte budget (`readerMaximumHtmlBytes`, ADR 0016) or 30,000 elements go to Feed mode before any parsing. The largest Wikipedia articles (about 2.8 MB, 23,000 elements) fit; a 3.8 MB page of 24,000 linked paragraphs, which held the thread for about 465 ms, does not. Bytes are counted as UTF-8 with `TextEncoder`, not `html.length`, so a non-Latin page (for example 1.6 million "Ж") cannot pass on its character count. Elements are counted as start tags in the source without building a DOM (tags in scripts and comments count too, which only errs towards the fallback), and Readability's `maxElemsToParse` backs this up for elements the parser adds itself.

### Extracted HTML is parsed in a detached document before sanitising

**Where:** `src/spa/reader-extraction.ts`, `sanitizeExtractedHtml()`

Extracted content is attacker-controlled HTML whichever extractor produced it. It is parsed with `DOMParser`, not into the live document, because an element owned by the live document starts loading its images while still detached, and an `onerror` handler would run in the app's origin before DOMPurify saw it. Relative URLs are rewritten against the article's real address, then DOMPurify strips unsafe content.

### Extracted images load lazily

**Where:** `src/spa/reader-extraction.ts`, `sanitizeExtractedHtml()`

As in the server-side sanitizer (`extract-article.ts`), images without their own hints get `loading="lazy"` and `decoding="async"`, so a whole extracted page in a scrolling pane does not fetch every image below the fold on open. Both attributes survive DOMPurify's default allowlist.

### article-extractor is a manual fallback that runs on the native DOM parser

**Where:** `src/spa/reader-extraction.ts`, `extractWithArticleExtractor()`

`@extractus/article-extractor` uses different heuristics (it falls back to meta tags and OpenGraph data more readily) and is offered in the mode picker for articles Readability mangles. It runs against the browser's own parser instead of a second pure-JS DOM, through `vendor/linkedom-shim`, which is almost all standard API with one documented difference in how a fragment is rooted.

### Opening an article starts on pointerdown; reader modes have nothing to prefetch

**Where:** `src/spa/articles-pane.tsx`, the row `onPointerDown`; `src/spa/dashboard.tsx`, `selectRows()`

Pressing a row starts the article GET before the click lands, and opening awaits that same request. Neighbour prefetching runs only in FEED mode: the reader modes fetch through the extension, so there is nothing server-side to warm.

### Article fetches share one in-flight request per article

**Where:** `src/spa/reading-prefetch.ts`, `ArticleFetches`, `neighbours()`

A press, a hover and the click that follows share one request per article id, because the service worker caches a response only once it lands and a second GET started earlier would hit the network too. Each request has its own controller: an open adopts the in-flight request so a late `pointercancel` cannot abort it, while the reader can still cancel the body when moving on; a plain primary press starts the click's own request early, outside the prefetch opt-in, and a press that turns into a scroll drops it. Opt-in prefetch (#716, #988) fetches the next article before the previous one because reading moves forward far more often, hovers count only on fine pointers, and a failed prefetch is ignored because opening the article reports its own failure.

### Prefetch honours Save Data

**Where:** `src/spa/reading-prefetch.ts`, `saveData()`

Save Data is the user telling every site to send fewer bytes, and a prefetch is exactly what they asked not to receive. Browsers without `navigator.connection` (Safari, Firefox) read as unconstrained. The member exists in Chromium but not in TypeScript's DOM library, so it is read through a narrow type assertion.

### YouTube embeds load nothing from YouTube until asked, and attachments preload nothing

**Where:** `src/spa/enclosures.tsx`, `YoutubeEmbed`, `shownEnclosures()`, `Enclosures`

The click-to-load cover (Smart-RSS's lite-youtube design) shows only the thumbnail and a play button until pressed; the load setting is read once, so changing it does not tear down a playing video, and the iframe keeps a Referer because YouTube refuses to play without one (error 153). Attachments follow Smart-RSS's layout, one collapsible block per file under the title, and players preload nothing until played. A YouTube article stored before enclosures existed, or relayed without one, still gets its player, and an image the body already shows is not shown twice.

### Overflowing code blocks join the tab order

**Where:** `src/spa/article-markup.tsx`, `ArticleMarkup`

A code block with long lines scrolls sideways, and a keyboard can scroll only what it can focus, so a block becomes focusable while it overflows. The size is observed rather than checked once, because a block laid out in a hidden pane measures nothing until the pane shows.

### Dismissing the Web Share sheet is not a failure

**Where:** `src/spa/share-article.ts`

The Web Share API rejects with a `DOMException` named `AbortError` when the user closes the sheet; that is reported as "dismissed" so the caller stays quiet. Any other share error is a real failure and falls back to copying the link to the clipboard.

## The feed tree

### A folder's article list is requested by folder id, not by its source ids

**Where:** `src/spa/feed-tree.ts`, `articleScope()`

When a folder is selected, the SPA sends the folder id and the server resolves the folder's sources (#976). Sending the folder's source ids instead would hit the request's 500-id cap for a large folder.

### Folders hold only sources, one level deep

**Where:** `src/spa/feed-tree.ts`, `findParentFolderUid()`

A folder holds sources, never another folder, so a source's folder is always among the top-level folders' direct children and the lookup does not recurse.

### Tree rows are keyed, compared and navigated by key and DOM order

**Where:** `src/spa/tree-item.tsx`, `ForEachNode()`, `TreeItem`, `moveTreeFocus()`

Every tree reload builds fresh node objects and `<For>` matches by reference, so a plain `<For>` would remount every row on each poll, dropping focus to `<body>` and replaying every favicon skeleton; `ForEachNode` keys rows on `treeNodeKey` and updates each node in place, and selection is compared by key for the same reason. Arrow-key focus movement reads row order from the DOM, since a closed folder's children are not rendered, and stops at the first and last row instead of wrapping, as the WAI-ARIA tree pattern asks; Home and End pass infinities that clamp to the ends.

### Tree updates that change nothing return the same array

**Where:** `src/spa/feed-tree.ts`, `withDecrementedUnread()`

The tree component diffs on identity to decide whether to re-render, so an unread update with no applicable delta returns the very array it was given.

### The tree keeps exactly one tab stop, falling back to the first visible row

**Where:** `src/spa/feed-tree.ts`, `treeTabStopKey()`

The tree is a roving tabindex: exactly one row has `tabindex="0"`, normally the row focused last. When a filter removes that row, the first row still shown takes over; otherwise the tree would have no rendered tab stop and Tab would skip it entirely.

### The tree's tab stop is computed once per focus change

**Where:** `src/spa/sources-pane.tsx`, `tabStop`; `src/spa/tree-item.tsx`

Every row reads the tab stop and working it out walks the whole tree, so it is computed once per focus change and shared. Computing it per row is O(N) walks of O(N) each.

### The feed filter keeps every child of a folder whose own name matches

**Where:** `src/spa/feed-tree.ts`, `filterTree()`

A folder whose name matches the filter keeps all its children: narrowing "News" to the one feed that also contains the word would hide the rest of the folder the user just named. A folder that does not match survives only through its matching descendants.

### The Today view shows no unread count and is absent from an empty tree

**Where:** `src/spa/feed-tree.ts`, `unreadCount()`, `withTodayNode()`

Today (#715) leads the user's tree but carries no unread count, because that number would need its own server aggregate and the view is one click away. An empty tree gets no Today row, because the first-run guidance owns that state.

### Snoozing a source is display-only

**Where:** `src/spa/dashboard.tsx`, `snoozeNode()`

The server keeps fetching and saving a snoozed source's articles. The client only stores the pause timestamp and reloads the tree, whose badges and unread lists suppress the source until the pause lapses (#725).

### "Snooze forever" stores a date ten years out

**Where:** `src/spa/feed-tree.ts`, `snoozePresets`

The forever preset of per-source snooze (#725) is ten years from now, not a sentinel value. That is far past any real pause, and the stored `pausedUntil` stays an honest timestamp that every date comparison handles.

### Snoozed and failing sources carry their own row marks

**Where:** `src/spa/tree-item.tsx`, `TreeItem`, `snoozed` and `failing`

A snoozed source (#725) keeps its place with no unread badge because the server zeroes its count, so the row needs its own mark or a muted feed looks like a quiet one. A source with repeated fetch failures is marked for the same reason, or a dead feed reads like a quiet, read-up one.

### Tree context menus act on a row without selecting it

**Where:** `src/spa/dashboard.tsx`, `openTreeContext()`; `src/spa/sources-pane.tsx`, `contextKey`; `src/spa/tree-item.tsx`

A context menu opened on a tree row acts on that row without selecting it, so the article list, its paging cursor and the reading position stay with the selection the user made (#721, #835). Manual ordering is a non-feature, so the menu has no re-filing action.

### A folder's group hangs off its treeitem through aria-owns

**Where:** `src/spa/tree-item.tsx`, `TreeItem`

The nested `<ul role="group">` is a DOM sibling of the folder's treeitem, because a button cannot contain a list, and the presentational `<li>` re-parents it onto the tree root, leaving `aria-expanded` pointing at nothing. `aria-owns` restores the nesting without turning the row into a non-button element, which would lose the native Enter and Space activation that `handleKeyDown` leaves to the button. Without it the accessibility tree flattens silently while the page looks identical.

### Folder open state is persisted and fails open

**Where:** `src/spa/tree-item.tsx`, `TreeItem`, `folderState`

Folder state is stored per folder uid, and only an explicit "closed" collapses one: an absent, older or corrupted entry reads as open, so a bad entry can never hide feeds. It is read once, which is safe because `ForEachNode` keeps each row's uid fixed.

### The folder toggle covers the chevron and the folder icon

**Where:** `src/spa/tree-item.tsx`, `TreeItem`, `.folder-toggle`

The chevron alone is too small for a finger, so the chevron and folder icon fold the folder as one target from the row's edge to its name; the rest of the row selects the folder.

### The tree's loading skeleton reserves the filter row

**Where:** `src/spa/sources-pane.tsx`, `SourcesPane` loading fallback

The skeleton renders the same filter row the loaded tree will have, so nothing moves when the tree arrives.

### Nested tree lists must not become scroll containers

**Where:** `src/spa/style.css`, `.tree.nested`

A nested folder list also matches `.tree` and can pick up its scroll-container treatment, reserving its own scrollbar gutter and indenting source rows out of line with the folder rows' unread counts.

### Skeleton shimmer animates a transform

**Where:** `src/spa/style.css`, `.skeleton-text::after`, `@keyframes skeleton-sweep`; `tests/browser/spa.spec.ts`, "sweeps the skeleton by transform, and not at all under reduced motion"

The loading skeleton renders about 190 bars (#881). Sliding each bar's pseudo-element by `transform` stays on the compositor, while animating the bar's own `background-position` repaints every bar on every frame. The sweep is off under reduced motion.

## New-article signal

### New articles raise a toast; the open list never changes while the user reads

**Where:** `src/spa/new-article-signal.ts`, `NewArticleSignal`

Extends ADR 0007. The tree already carries every source's unread count, so a rise in the total is the whole signal (#717); the open article list is never changed mid-read, and a toast asks instead. The poll resets its backoff when the user refreshes and skips cycles in a hidden tab, and a failed poll is silent apart from `onPollFailure` while the next cycle retries.

### Only one new-article poll runs at a time

**Where:** `src/spa/new-article-signal.ts`, `NewArticleSignal#poll()`, `streamSignal()`

Extends ADR 0007. A tree load aborts the one before it, so stream signals arriving faster than the tree loads would never let one finish. A signal during a poll is remembered and gets one follow-up poll after it.

### A failing push stream only ever moves the poll closer

**Where:** `src/spa/new-article-signal.ts`, `streamFailed()`

Extends ADR 0007. When the stream fails, the poll is rescheduled only if that makes it sooner. A proxy that accepts the stream and drops it on every reconnect must not keep pushing the poll further out.

### The tab-title unread count is account-wide

**Where:** `src/spa/news-signal.ts`, `unreadTotal`

The document title shows the total unread across every source, not the selected view's count, because the tab is about the account, not the pane. It is zero while no dashboard is mounted, so a logged-out tab keeps no count.

## Panes, routes and history

### Pane-layout media queries are duplicated in style.css and held equal by a test

**Where:** `src/spa/panes.ts`, `SINGLE_PANE_QUERY`, `TWO_PANE_QUERY`, `FINE_POINTER_QUERY`; `src/spa/__tests__/media-queries.test.ts`

One pane shows on a phone and on a portrait tablet, whose width cannot fit three panes of touch-size rows. Two panes show on a landscape touch screen below 1200 px, where three would leave each too narrow for names and titles; the feeds stay beside the list and the reader takes the list's place while an article is open. `style.css` cannot import these strings, so each copy there carries a comment pointing to `panes.ts`, and the test fails on any single-pane or hover query that differs from its constant; a drifted copy would let the stylesheet show three panes while `switchPane` animates as if one were showing. `FINE_POINTER_QUERY` (mouse or trackpad, where resting on a row usually means a click is coming) is kept in sync the same way.

### Pane switches cross-fade only in the single-pane layout

**Where:** `src/spa/panes.ts`, `switchPane()`

A pane switch uses a view transition (#990) only in the single-pane layout and without reduced motion. On wider screens every pane stays in place and a fade would only dim the page. A navigation the browser already animated (a swipe back) gets no second animation.

### A skipped view transition's rejected `ready` is ignored

**Where:** `src/spa/main.tsx`, `paneSwitchHost.startViewTransition`; `src/spa/panes.ts`, `switchPane()`

When a second pane switch starts before the first transition's animation, the browser skips the first one and rejects its `ready` promise. Nothing waits on the animation, and the switch itself still applies through `updateCallbackDone`, which `switchPane()` awaits, so the rejection is caught and discarded.

### Pane switches read the pane from history state

**Where:** `src/spa/main.tsx`, `focusPane()`, `openDiscovery()`

The current pane is read from `history.state`, not the `pane()` signal. A pushed switch that is still waiting for its transition has not set the signal yet, and a second tap in that frame would push a duplicate entry that Back then has to step through.

### Discover is a history-state flag beside the pane

**Where:** `src/spa/panes.ts`, `isDiscoveryEntry()`, `withDiscovery()`, `withDashboardPane()`

Discover opened over the panes is its own history entry, so Back closes it rather than leaving for the page before the dashboard. It is a flag beside the pane, not a fourth pane, because Discover switches between panes of its own and `withDashboardPane()` keeps the flag on those entries.

### Closing Discover steps back through all its history entries

**Where:** `src/spa/main.tsx`, `closeDiscovery()`, `popstate`

Discover closes at once on screen, but each preview article it opened on a phone pushed another history entry. `closeDiscovery()` steps Back through all of them, and the promise it returns settles only when history is back on the entry Discover opened over, so a pane switch that follows is not the one that Back undoes.

### Discover's starting state outlives a close

**Where:** `src/spa/dashboard.tsx`, `showDiscovery()`

Discover opens on the `/preview` route or on the history entry opening it pushed. What it started with is kept after it closes, so Forward back into its entry opens the same form again.

### A reload starts on the feeds pane

**Where:** `src/spa/main.tsx`, `App` (the initial `history.replaceState`)

On load, the dashboard's history entry is reset to the feeds pane with Discover closed. Discover's half-filled form does not survive a reload, so restoring its entry would only reopen it empty.

### An in-app way home becomes Back when it returns to the previous address

**Where:** `src/spa/main.tsx`, `navigate()`; `src/spa/panes.ts`, `previousPath()`

Each in-app navigation records the address it left in history state (`feedFathomFrom`). Off the panes, navigating to that address calls `history.back()` instead of pushing, so the way home from Options does not stack a second dashboard entry for the system Back to step through. On the panes this does not apply, because a pane switch copies its entry's state, return address included, and Back would land on the previous pane.

## Focus, keyboard and accessibility

### Keyboard focus follows removals and pane switches

**Where:** `src/spa/dashboard.tsx`, `focusArticleAt()`, `dropRows()`, `showReaderPane()`, `handleReaderKeys()`, `removeNode()`, `onSelectAll`

Rows get real DOM focus with the tree's roving tabindex so the browser announces the focused row itself, and focus waits until the pane has shown because a row in a pane still fading in is `display:none`. Removing rows or a tree node deletes the focused element, which drops focus to `<body>`, so the row that took its place is selected and focused. On a narrow screen a pane switch hides the pane holding focus, so opening an article and `o` move focus to the pane they show (#816); the reader pane then handles only `o`, leaving every other key its browser meaning so the pane scrolls from the keyboard. Clicking "Select all" focuses a button outside the list, where list keys stop working, so focus moves to the first row.

### Focus into a pane waits until the pane is shown

**Where:** `src/spa/main.tsx`, `showPane()`, `whenPaneShown()`

Under a view transition the pane switch applies a frame later, and until then the new pane is still `display: none`, so a `focus()` into it would fall to `<body>`. Code that focuses inside a pane waits for the transition's promise. Without a transition the switch is a signal write that shows at Solid's flush, and a microtask queued at that point runs after it.

### Route changes move focus to `<main>`; pane changes do not

**Where:** `src/spa/main.tsx`, the deferred `createEffect` on `path`

A route swap replaces the page without the focus reset a real navigation gives, so Tab would continue from wherever the old page's link was. After each path change (not the first render) focus moves to `<main>`, which works for every route without per-page targets; the dashboard's own tree focus runs later and wins. Pane changes keep the same path, so `setPath`'s equality check stops the effect and moving between panes never steals focus.

### The focus ring follows the last input type, not :focus-visible alone

**Where:** `src/spa/main.tsx`, the `keydown` and `pointerdown` listeners that set `data-input`

The app focuses rows by itself (the first tree row on load), and Chromium's `:focus-visible` treats that as keyboard focus, so the cursor ring would show before the user typed anything. The page records the last input type on `<html>` as `data-input`, and the ring is tied to keyboard use. A bare modifier key is not input, and Shift-click still counts as a pointer.

### Article list keys: arrows take modifiers, letters answer only bare, Enter reads in the app

**Where:** `src/spa/keyboard-shortcuts.ts`, `mapArticleKey()`

Navigation keys answer with any modifier, because Ctrl or Cmd on an arrow moves the cursor without selecting and the handler reads that itself. The letter keys are the usual RSS-reader set (#709) and answer only without modifiers, so a chorded press keeps its browser meaning. Enter reads the row in the app (#1029), because that is what activating a listbox option means to a screen-reader user; `v` opens the original site.

### Text-entry detection uses structural checks, not DOM classes

**Where:** `src/spa/keyboard-shortcuts.ts`, `isTextEntry()`

Key presses in text fields are content, not commands. The check reads `isContentEditable` and `nodeName` structurally instead of using `instanceof HTMLElement`, so unit tests can pass plain objects without a DOM.

### Announcements go through an always-rendered live region, once per action

**Where:** `src/spa/dashboard.tsx`, `announce()`, the high-contrast hint; `tests/browser/spa.spec.ts`, "announces mark-read and delete results once per action"

A screen reader cannot be detected, so the polite live region always renders, visually hidden. Bulk and destructive actions say what they did once per action, not once per row (#1028). The region speaks only when its text changes, so `announce()` clears it and sets the message a task later, or a repeated message would be silent. The hint that a high-contrast theme exists is set two seconds after boot rather than at mount, so a screen reader treats it as a live-region change instead of part of the first read-through.

### ARIA lists own only their items

**Where:** `src/spa/articles-pane.tsx`, the empty-state `Switch`; `src/spa/feed-discovery.tsx`, the preview `role="list"`

A listbox may own only option and group children, so the empty-state message is a sibling of the listbox, not a child (#933); `.article-list-empty` in `style.css` keeps the listbox's flex slot. Likewise the Discover preview's `role="list"` wraps only the rows, and the truncation note sits beside it.

### Article rows keep the browser's own context menu

**Where:** `src/spa/articles-pane.tsx`, the article row link; `tests/browser/spa.spec.ts`, "leaves the article context menu to the browser"

The row is a real link, and the browser's menu on any pointer carries "open in a background tab" (the only way to get one on a phone, which has no middle click and where `window.open` always foregrounds), copy link, save, and whatever the reader's extensions add. Overriding `contextmenu` would lose all of that. Tree rows are buttons with no platform menu to lose, so they keep the app's menu.

### The custom context menu's focus and dismissal rules

**Where:** `src/spa/context-menu.tsx`, `ContextMenu`, `longPressHandlers()`

App-specific actions need a custom menu (#721). It opens nudged off the pointer so a stray pointerup cannot activate the first item, and it is clamped to the viewport once it has a real size, because a long-press near a screen edge is the common touch case. Escape dismisses and returns focus to the invoker; an outside press dismisses without restoring focus; Tab closes the menu and returns focus first so the browser's own Tab moves on from the invoker (WAI-ARIA menu pattern); an item's action runs after the menu closes so panes and dialogs it opens do not fight the menu for focus. Long-press cancels on movement, which is a scroll, and swallows the click the release would produce.

### In-app dialogs replace native prompt() and confirm()

**Where:** `src/spa/dialog.tsx`, `DialogHost`

Native `prompt()` and `confirm()` block the event loop, can be suppressed by the browser (after which folder creation silently did nothing), work poorly on touch screens and cannot follow the theme (#698). One `<dialog>` hosted in `main.tsx` serves every call, and `showModal()` provides the focus trap, inert background and Escape handling. Its accessible name is the visible title and a confirm's message describes it (#817); the confirm button must carry the action's verb, with no "OK" default; and the caption close box, shown only by the windowed themes, is out of the tab order because Escape and Cancel already close the dialog.

### A dialog's promise always settles

**Where:** `src/spa/dialog.tsx`, `show()`, `cancelValue()`, `DialogHost`

Both request kinds store one resolve signature, the broader of the two, so dismissals route without casts. Cancel, Escape and backdrop clicks resolve with the native cancellation values (`false` for confirm, `null` for prompt), with Escape routed through `cancel()`. A request replacing a pending one cancels it and reuses its dialog and original invoker; unmounting with a dialog open resolves it; and `onClose` cancels only when the dialog is actually closed, because `close` fires a task after `finish()` and a follow-on request may have reopened it (#1123). Any of these gaps leaves a caller awaiting forever.

### Icons are inlined SVG so they take the surrounding text colour

**Where:** `src/spa/icon.tsx`, `Icon`

Icons are imported as raw SVG (`?raw`) and inserted inline rather than through `<img src>`. They use `fill`/`stroke="currentColor"`, which resolves against the page only when inlined, so every icon matches its context (dark mode, a theme's selected-row colour) without per-theme variants.

## Solid reactivity

### Solid 2 defers setter visibility, so callers pass fresh values or flush first

**Where:** `src/spa/admin.tsx`, `load()`; `src/spa/dashboard.tsx`, `applyUnreadDeltas()`, `selectRows()`, `select()`, `runSearch()`, `changeArticleFilter()`; `src/spa/feed-discovery.tsx`, `findFeeds()`, `useNewsletterAddress()`; `src/spa/reader-pane.tsx`, the display mode `<select>` handler

A signal read right after its setter still returns the old value until Solid's next microtask flush. Code that just set a value either passes the new value along as an argument (the admin sort column and direction, the replaced rows, the computed tree) or calls `flush()` before the code that reads it (the article filter before a list request, the normalized website link before its validity check, a minted address before it is copied, the reader mode before `onModeChange()` reopens the article in it). Removing either makes the following request or check use the previous value.

### Values read outside tracking are owned memos, not inline conditionals

**Where:** `src/spa/dashboard.tsx`, `editedSource`; `src/spa/main.tsx`, `Router` (`preview`)

Discover's edited source and the Dashboard's `preview` prop are read from `onSettled` and event handlers. An inline conditional there creates a memo per read, outside any owner, so each is a `createMemo` created once in its component.

### The folder select's value is set together with its options

**Where:** `src/spa/feed-discovery.tsx`, the folder load in `onSettled`

Assigning a `<select>` value before its matching `<option>` exists selects nothing, and Solid does not reapply the binding when options appear later. The folder id is set in the same step as the loaded folders; setting it earlier silently falls back to "No folder".

### PasswordInput's value prop is required

**Where:** `src/spa/password-input.tsx`, `PasswordInput` props

Solid re-applies the `value` binding whenever the element's other bindings change. A field bound to nothing would be wiped while the user types, so `value` is required.

### storedPreference's implementation signature is not generic

**Where:** `src/spa/preferences.ts`, `storedPreference()`

The public overload is generic, but the implementation takes `boolean | string`. `createSignal` cannot see that a generic `T` is never a function, which its initial value must not be, so a generic implementation does not type-check.

## Preferences

### Preferences fall back silently when storage fails

**Where:** `src/spa/preferences.ts`, `storedPreference()`

Each preference is one localStorage key holding `String(value)`, read at load and again when another tab writes it; a `storage` event with a null key means another tab cleared all storage. Storage throws in private browsing and when the origin has no storage access, so reads and writes fall back silently. A stored value that is not one of the allowed values reads as the fallback, and toggles stored as "on"/"off" before they became booleans still read correctly.

### Prefetching and offline reading are off until the reader turns them on

**Where:** `src/spa/preferences.ts`, `prefetchNext`, `offlineUnread`

Both download articles in the background without a further action from the reader, so neither may start without consent. Prefetching the next article (#716) costs one extra extract-route hit per opened article, which some users count as waste; offline reading (#992) downloads every recent unread body, a much larger cost. Both defaults stay `false`, and a test pins that.

### Today view, search boxes and session restoration are opt-out

**Where:** `src/spa/preferences.ts`, `todayView`, `feedFilterBox`, `articleSearchBox`, `rememberReadingPosition`

The Today view (#715) is on by default, and the toggle exists because pure source navigation is a legitimate preference. The sidebar feed filter and the article search are separate opt-out settings: each costs a row in a pane with little vertical space, a reader with a dozen feeds needs neither, and they do different work (the filter narrows what is loaded, search asks the server). Session restoration (#718) is on by default because reopening the app should feel like the user never left; off, no snapshot is written or restored.

### The unread badge and background polling are separate toggles

**Where:** `src/spa/preferences.ts`, `unreadBadge`, `backgroundPoll`

The new-article signal (#717) has two independent toggles. The badge is free, but background polling costs server load, and an operator who wants zero background traffic can turn polling off and keep the tab-title count.

### The auto theme switches to high contrast on the OS accessibility signal

**Where:** `src/spa/preferences.ts`, `prefersHighContrast()`, `resolvedTheme()`

A page cannot read the desktop theme or OS version (User-Agent sniffing for that is unreliable and being phased out), but it can read the OS high-contrast preference through `forced-colors` and `prefers-contrast`. The `auto` theme normally passes through, and its CSS block uses the browser's live system colours so the selection colour is the OS accent. When the OS signal is on, `auto` resolves to the app's contrast-checked `high-contrast` theme; other themes pass through unchanged.

### Reader typography has three fixed steps per axis

**Where:** `src/spa/preferences.ts`, `readerText`, `readerWidth`

Reader text size and line width (#712) each have three steps rather than a free number. The defaults set in #719 are the middle step, and a slider would allow line widths the measure rule exists to prevent. The steps reach the stylesheet as data attributes on `<html>`, like the theme, so the values stay in CSS with the rules that use them.

### The phone article list is bottom-anchored by default

**Where:** `src/spa/preferences.ts`, `mobileListAnchor`

On a phone the list fills the viewport, so a list shorter than one screen leaves a blank stretch under its last row. Bottom-anchoring the rows closes that gap and ships on, because the blank stretch looks unfinished and the rows still scroll normally once the list overflows. Some readers prefer the list to end where its content ends, hence the toggle.

### A single attachment opens by default

**Where:** `src/spa/preferences.ts`, `enclosuresOpen`

Attachment blocks start expanded only when there is one, as in Smart-RSS: a lone attachment (an episode, a video) is usually the point of the article, while several are usually a gallery.

### YouTube embeds load on click from the cookieless host by default

**Where:** `src/spa/preferences.ts`, `youtubeLoad`, `youtubeHost`

Until the reader clicks, YouTube receives nothing but the thumbnail request. The cookieless host is the default for the same privacy reason; the main host keeps the viewer's YouTube login (Premium, history) at the cost of letting YouTube follow them.

## The Options page

### Only the Options route scrolls the document

**Where:** `src/spa/main.tsx`, the `createEffect` that sets `data-route`; `src/spa/style.css`, `html[data-route="options"]`; `tests/browser/spa.spec.ts`, "scrolls the options page when the settings exceed the viewport"

The Options page is the one page whose document scrolls: its settings run past a viewport, and making the centred column the scroller read as a cut-off page with a trapped scrollbar. Everywhere else `html` and `body` stay `overflow: hidden` with `overscroll-behavior: none`, `.dashboard` is fixed to the viewport at `100dvh` with `overflow: clip`, `.dashboard-pane` clips without creating a programmatic scroll container, and the pane lists carry `min-height: 0` and `overscroll-behavior: contain` so scrolling a long list cannot chain to the root viewport or push a toolbar off screen on Firefox for Android. Leaving Options resets the page scroll before locking `data-route`, because hidden overflow would otherwise trap the viewport where Options left it. On Options `html` and `body` keep `overflow: visible` and `overscroll-behavior: auto`, because with `overflow: auto` Gecko keeps `body` a scroll container (Chromium propagates it to the viewport), and Home/End and gesture scrolling then move the body invisibly instead of the page.

### Options scrolls to the URL hash itself

**Where:** `src/spa/options.tsx`, `Options` (the `scrollToHashTarget` call)

SPA navigation never scrolls on its own, so Options honours the hash once the selected section has rendered. A section id lands at the top of the page; any other hash names an element inside a section and scrolls to it.

### Old Options hashes stay as aliases

**Where:** `src/spa/options.tsx`, `sectionAliases`

Links and bookmarks still carry older hashes: `#import-opml` is the import form's own id, which the empty-tree guidance links to, and `#signal` and `#data` are tabs that were merged or renamed. The aliases map them to current tabs so those links keep working.

### The Keyboard tab is hidden on touch-only devices, but its hash still opens it

**Where:** `src/spa/options.tsx`, the `options-keyboard` class on the section nav

A touch-only device has no keyboard for the shortcuts, so `style.css` hides that tab there. The `#keyboard` hash still opens it.

### The narrow-screen settings card shows only in the single-pane layout

**Where:** `src/spa/options.tsx`, the `options-mobile-layout` card

`style.css` shows this card only under the single-pane media query (`SINGLE_PANE_QUERY` in `panes.ts`), the only layout where its settings exist.

### Preference hints sit outside the label

**Where:** `src/spa/options.tsx`, `PreferenceSelect`, `PreferenceCheckbox`

A setting's hint is placed outside its `<label>` and linked with `aria-describedby`. Inside the label it would become part of the control's accessible name.

### OPML export is a plain download link

**Where:** `src/spa/options.tsx`, the Export OPML link

The export is an `<a download>` to `/api/options/opml`, not a fetch. The API is cookie-authenticated, so the browser downloads the file directly without the SPA holding it in memory first.

### The session list reloads after a password change

**Where:** `src/spa/options.tsx`, the password change handler

Changing the password signs out every other session, so the page reloads the session list to show what remains.

### User-agent labels are parsed in-house, most specific first

**Where:** `src/spa/user-agent.ts`

Session rows show a recognisable browser and platform name instead of the raw User-Agent. Browser tokens arrive in different orders and aliases (CriOS, Edg, SamsungBrowser), so checks run most specific first, and the iOS and Android checks precede the desktop Mac and Linux ones they impersonate. There is no dependency and no exhaustive database: an unknown format shows the raw header, which is more informative than a guess, and a session with no header renders as "Unknown device".

## Discover and subscribing

### A newsletter address is reserved the moment it is minted

**Where:** `src/spa/feed-discovery.tsx`, `mintNewsletterAddress()`, `reserveNewsletterAddress()`, `reportUnreserved()`

`mailDomain` is set only where the server ingests mail, which gates the newsletter button, and the effect waits for it because the session may still be loading. Once shown, the address is in the user's hands, and mail sent to it before its source exists bounces for good, which can end the subscription before it starts (#1116), so the source is created at mint time, not on Subscribe. The address also goes into the URL as `?feedUrl=`, so a reload or a restored tab shows the address already copied instead of minting a new one, and reserving that address again is idempotent and recovers a failed first reservation. If reserving fails, Subscribe still creates the source, so only mail sent until then is lost, and the user is told.

### A subscribed feed's URL cannot be edited

**Where:** `src/spa/feed-discovery.tsx`, the Website and Feed URL inputs (`readonly`)

A source is shared and deduplicated across every subscriber (`sources_url_unique`), so editing its URL would silently repoint everyone else's subscription. Both fields are read-only when editing; unsubscribing and subscribing to the other URL is the supported way to switch feeds.

### The website field accepts bare hosts and rejects non-web schemes in the browser

**Where:** `src/spa/discovery-behavior.ts`, `withScheme()`, `websiteValidationMessage()`

People type "example.com", so a scheme is added, but not to a mail address, which is what they type to subscribe a newsletter. Anything that is not http(s), including `javascript:` and `data:` values a paste can carry, is rejected by the field's constraint validation rather than at the server.

### Modified clicks in the Discover preview pass through to the browser

**Where:** `src/spa/feed-discovery.tsx`, `selectPreviewArticle()`

Ctrl, Cmd, Shift or Alt on a click is the browser's gesture for opening a link elsewhere, so the pane does not swallow it by selecting.

## Accounts and admin

### Account activation needs a button press, never a page visit

**Where:** `src/spa/account-flows.tsx`, `activate()`

Mail previewers and link scanners open the activation URL and may run the page. The token must stay exactly as usable for the person who follows the link afterwards, so loading the page does nothing and only the button activates (#810).

### The password-reset confirmation never says whether the account exists

**Where:** `src/spa/account-flows.tsx`, the reset request confirmation

The page says a link is on its way "if that address has an account here", not "we sent you an email". Confirming the send only for existing accounts would answer the question the login form refuses to answer.

### The password-reset link appears only when the server can send mail

**Where:** `src/spa/account-flows.tsx`, `loadResetEnabled()`

Without outgoing mail there is no link to deliver, and the reset route answers as it would for an unknown account, so offering it would send people somewhere that cannot help. If loading the setting fails, the link stays hidden, which is the same harmless outcome.

### Account forms share one set of client-side rules and turn native validation off

**Where:** `src/spa/account-validation.ts`, `accountFieldErrors()`

Login, registration and both password-reset steps check their fields with the same rules before sending anything, and report a missing or malformed field as a sentence under that field. The forms use `novalidate` because the browser's validation bubbles spoke in a different voice and blocked the app's own messages. Passwords are checked exactly as typed; a name or address made only of spaces counts as empty.

### The password field has a show/hide toggle outside its label

**Where:** `src/spa/password-input.tsx`, `PasswordInput`

A password you cannot read back hides typos until the server rejects them, and on login each rejection costs one of a bounded number of attempts, so the field has a show/hide toggle. The toggle sits beside the label: a `<label>` may contain no interactive content other than its own control, and a button inside would also pick up the label's click forwarding. `invalidMessageId` marks the field invalid when the message is shown elsewhere, such as a whole-form error.

### The admin source table stacks on narrow screens

**Where:** `src/spa/admin.tsx`, `Admin`

Where the table stacks, its header row has no columns to head, so a single "Sort by" select replaces the header sort buttons (`style.css` shows one or the other), and each cell's `data-label` captions its value. The flex row of action buttons lives inside the actions cell, because a flex `<td>` stops being a table cell and breaks the row rules. The common WebSub status "none" renders as an em dash so it does not compete for attention with the sources that have a hub.

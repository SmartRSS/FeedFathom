# 0019 — Extension: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Reader bridge and instance

### The reader fetch trusts only the instance's top frame and never follows redirects

**Where:** `src/extension/reader-fetch.ts`, `isReaderSender()`, `handleReaderRequest()`

The sender must be the top frame of the configured instance and carry exactly `frameId` and `url`; an extra key means the sender is not the shape that was vouched for. The fetch uses `redirect: "manual"`, because a redirect would lead to a host nobody validated; under "manual" every browser answers with an opaque redirect that hides its target.

### Messages to a dead extension context are dropped

**Where:** `src/extension/content-script.ts`, the `runtime.sendMessage` calls

Once the extension is reloaded or removed under a page that still runs the content script, `runtime.sendMessage` throws or rejects, depending on the browser. Both are caught: the reader bridge answers the page UNAVAILABLE, and feed reports have no one left to report to.

### The instance check is a GET of /api/session

**Where:** `src/extension/instance.ts`, `pingInstance()`

`/api/session` answers 200 whether or not anyone is signed in, so it is the cheapest request that proves an address is a reachable FeedFathom; the options page's "Test connection" button reports on it. It returns `false` rather than throwing, because the explanation is the caller's message to write.

## Feed discovery: menu, popup and badge

### Without a contextMenus API the toolbar icon opens a popup

**Where:** `src/extension/background-event.ts`, the `contextMenus` check and `action.setPopup`; `src/extension/popup.ts`

Firefox for Android has no `contextMenus` API, and touching it throws synchronously, which would abort the whole background script before it finishes loading, including the `runtime.onMessage` listener the reader bridge depends on. Where the API is missing, the background sets `popup.html` as the toolbar popup so subscribing still works without a right-click menu; the popup exists only for that case. `setBadgeBackgroundColor` is wrapped in a try for the same reason. The background stores each reported feed list for the popup independently of the menu update.

### The popup asks the page for a fresh scan

**Where:** `src/extension/popup.ts`, `requestLiveFeeds()`; `src/extension/content-script.ts`

The context menu can wait for the content script's debounced on-load scan. The popup cannot: it opens on demand, often before that debounce fires, so it asks the active tab's content script to scan now. It falls back to the cached copy in session storage when there is no content script to ask, such as a popup opened directly or a page content scripts cannot run on. Each feed shows its title over its URL, as the dashboard's discovery list does, because a site whose feeds share a long title prefix would otherwise show several identically clipped rows.

### The background owns the per-tab feed badge

**Where:** `src/extension/background-event.ts`, `setTabBadge()`, `clearTabBadge()`

Content scripts cannot touch `chrome.action`, so they report the found-feed count with the list-feeds and visibility-lost messages and the background sets the badge. `setBadgeText` is always called with a `tabId`; without one it would stamp every tab with the last report. A navigation (status `loading`) clears the tab's badge, and the content script reports again after its next scan. Turning the badge setting off clears every badge already on screen, because a page left open may never scan again; `tabs.query({})` and reading `status` need no `tabs` permission (only reading a tab's url or title does), and tabs without an id, such as devtools, are skipped.

### The badge uses the icon's orange and caps at 99+

**Where:** `src/extension/badge.ts`, `badgeColor`, `formatBadgeCount()`

The badge is the only hint, short of opening the popup, that the page has feeds. Its colour is the icon's own orange (`src/spa/assets/*-inverted-round.png`), so it reads as part of the button rather than a notification pasted on it. Chrome clips badge text to about four characters and Firefox to fewer, so counts above 99 show "99+", and zero clears the badge.

### Badge on by default, OpenRSS off by default

**Where:** `src/extension/settings.ts`, `settingsFrom()`

The badge is opt-out (#768): only an explicit `false` turns it off, so a storage failure never silently disables it. The OpenRSS suggestion is opt-in: it sends the page address to a third party, so only an explicit `true` turns it on.

### Context menu operations settle in their callback

**Where:** `src/extension/context-menu.ts`, `callbackPromise()`

`chrome.contextMenus` reports failure only through `runtime.lastError` inside the callback, so each operation is wrapped in a promise that settles there.

### Menu rebuilds run one at a time from the latest request

**Where:** `src/extension/menu-sync.ts`, `createMenuSync()`

The browser builds context menus asynchronously, so rebuilds run one at a time and each starts from the latest request; a report or clear that arrives mid-rebuild is applied by the next pass instead of interleaving with this one. Feeds are deduplicated by URL first, because the URL is the menu item id and `create()` rejects a duplicate id, which would drop that entry.

### Rescans wait for a single-page app to settle

**Where:** `src/extension/page-scanner.ts`, `scanDebounceMs`

A single-page app swaps its content after the address changes, so the rescan after an address change waits 1.5 seconds for the new page to settle.

## Options and extension pages

### The options page attaches listeners before reading storage and reports errors inline

**Where:** `src/extension/options.ts`, `showError`; `tests/browser/extension-popup.spec.ts`

Every listener is attached before the first await. Reading storage is a round trip to the extension process and `load` fires when the script starts, so a change arriving before the read lands would otherwise reach no listener; stored values are filled in afterwards. A rejected instance address shows an inline message rather than `alert()`, because a browser can offer to suppress repeated dialogs, after which the field would revert with nothing said. The message names the rule people hit most: plain http is accepted only for loopback.

### Extension pages are styled only by extension.css

**Where:** `src/extension/manifest.json`, `content_security_policy.extension_pages`; `src/extension/extension.css`

The `extension_pages` CSP sets no `style-src`, so it falls back to `default-src 'self'` and any inline `<style>` is dropped; extension pages take their styles from `extension.css`.

### The newsletter action opens the SPA to mint an address

**Where:** `src/extension/url-helpers.ts`, `OpenTarget`, the `newsletter` target; `src/spa/feed-discovery.tsx`, `mintNewsletterAddress()`; `tests/browser/spa.spec.ts`

The extension opens the SPA's `?newsletter` preview URL instead of minting an address itself, so every new address comes in the SPA's format. The SPA puts the minted address in the URL so a reload does not replace one already copied; the reload reserves it again, which is a no-op once reserved.

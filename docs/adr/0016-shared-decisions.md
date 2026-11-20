# 0016 — Shared: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## The reader bridge

### The reader bridge accepts only exact messages from its own window

**Where:** `src/shared/reader-bridge.ts`, `isReaderRequest()`; `src/spa/extension-reader.ts`, `createExtensionReaderBridge()`

The bridge is how article HTML from the extension enters the page, so its strict message shapes are a security property. The extension acts only on a request it recognises exactly. The page accepts an answer only if it comes from this window, on this origin, for the request id and action it sent. Anything else (another frame, another origin, a forged id or action) is ignored, and the real answer still lands.

### The page outwaits the extension's fetch timeout, and both ends share one byte budget

**Where:** `src/shared/reader-bridge.ts`, `readerFetchTimeoutMs`, `readerResponseTimeoutMs`, `readerMaximumHtmlBytes`; `src/extension/reader-fetch.ts`; `src/spa/reader-extraction.ts`, `assertWithinBudget()`

The extension gives up on an article fetch after `readerFetchTimeoutMs` and answers TIMEOUT. The page waits five seconds longer, so a slow fetch reaches it as TIMEOUT rather than as a silent UNAVAILABLE. One HTML budget serves both ends: the extension refuses a larger body before transferring it, and the page refuses decoded HTML whose UTF-8 size exceeds it before parsing (ADR 0017 records why the page counts bytes, not characters).

## Network and URL safety

### One table of blocked address ranges, checked against URL.hostname

**Where:** `src/shared/net/private-network-guard.ts`, `isBlockedAddress()`, `isBlockedHostname()`

This is the only table of non-global ranges and local hostnames. The server checks every hostname and every resolved address against it in the native transport; the extension, which cannot resolve DNS, checks the hostname alone. Callers must pass a WHATWG `URL.hostname`, which has already turned inet_aton forms such as `127.1` or `0x7f000001` into a dotted quad and rejected what does not parse. An address that does not parse counts as blocked, so the guard fails closed.

### URLs with credentials are refused

**Where:** `src/shared/util/safe-url.ts`, `httpUrlWithoutCredentials()`

Only an absolute http(s) URL with no username or password passes. A URL that carries credentials would send them to whatever host it names.

### Host matching requires the domain or a dot before it

**Where:** `src/shared/scanners/host.ts`, `hostIs()`

A host matches when it equals the domain or ends with `.` plus the domain. A bare suffix test would also accept `evilhive.blog` for `hive.blog`.

## Contracts between versions and bundles

### Fields added to a contract after release are optional

**Where:** `src/shared/contracts/requests.ts`, `articlesRequest` (`filter`, `revision`); `src/shared/contracts/responses.ts` (`failing`, `pausedUntil`, `enclosures`)

Clients and servers of different versions talk to each other, and the service worker keeps old responses cached. So a response field added later (`failing`, `pausedUntil` from #725, `enclosures`) is optional, and clients read its absence as the old behaviour, such as not snoozed. A request field is opt-in when an older bundle's schema would reject what it triggers: `revision` is sent only when asked for, and an absent `filter` means unread, the only list older clients know.

### Client-facing limits stay free of the schema library

**Where:** `src/shared/contracts/limits.ts`

These are server-owned numbers that the clients also act on or show. The module imports nothing, so the service worker bundle can import it without pulling in typebox. Moving a schema into this file would put typebox into the service worker.

### Stored failure reasons are a contract across deploys

**Where:** `src/shared/util/fetch-failure.ts`, `httpStatusFailure()`, `classifyFetchFailure()`

The reason the fetcher stores for a non-200 answer outlives a deploy in `sources.recent_failure_details`, and `classifyFetchFailure` parses its wording. Changing the sentence in `httpStatusFailure` misclassifies every reason stored before the change.

### Email addresses are capped at 254 characters

**Where:** `src/shared/validation/address-shape.ts`, `maxEmailAddressLength`; `src/shared/contracts/requests.ts`, `mailEnvelopeValue`

Extends ADR 0004. RFC 5321 caps a forward path at 256 octets including the angle brackets, so no deliverable address is longer than 254. The same cap applies to both inbound mail envelope paths, since no deliverable sender is longer than a minted recipient may be.

## Fetch failures shown to readers

### The reader sentence for a fetch failure omits the URL and the status

**Where:** `src/shared/util/fetch-failure.ts`, `classifyFetchFailure()`

The fetcher stores failures in its own words; `classifyFetchFailure` sorts them into the few causes a reader can act on, each with a plain sentence, and `editable` marks the causes a new address can fix. The URL stays out because wherever the sentence shows, the feed is already named. The status is kept for an admin's details.

## Parsing helpers

### Body decoding finds the declared encoding in a windows-1252 prefix

**Where:** `src/shared/util/decode-body.ts`, `decodeXml()`, `detectHtmlEncoding()`

The in-document declaration (XML prolog, HTML `<meta>`) is ASCII-compatible, so decoding a body's prefix as windows-1252, an ASCII superset with no invalid byte sequences, is always safe for finding it. A feed follows the feed order: BOM, Content-Type charset, XML prolog, then UTF-8, and an unknown label falls back to UTF-8. An HTML page follows the HTML spec instead: an unknown header label is ignored, the meta prescan skips comments and unknown labels, a meta that names UTF-16 cannot be true when read as ASCII, and `x-user-defined` means windows-1252.

### Both scanner extractors take the first match of each single-valued selector

**Where:** `src/shared/scanners/scanner-page.ts`, `scannerSelectors`; `src/extension/document-scanner.ts`; `src/features/feeds/html-scanner.ts`

The extension's extractor over the live Document and the server's HTMLRewriter pass both build a `ScannerPage` from this table, and both take the first match of each single-valued selector. An extractor that took a different match would make discovery in the extension and on the server disagree.

### srcset candidates split only at a real separator

**Where:** `src/shared/util/srcset.ts`, `candidateSeparator`

A candidate ends at a comma followed by whitespace, or at a comma right after its descriptor. A comma inside a URL, as in a `data:` URI, splits nothing; splitting on every comma would corrupt such candidates.

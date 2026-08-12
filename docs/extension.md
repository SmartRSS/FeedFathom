---
layout: default
title: Browser Extensions
nav_order: 3
---

# Browser Extensions

## Download Extensions

Download our browser extensions to easily subscribe to feeds when browsing the web.

<div class="download-container" markdown="1">
### Firefox Extension

**Version:** FIREFOX_VERSION

[Download for Firefox](FIREFOX_DOWNLOAD_URL){: .btn .btn-primary }
</div>

<div class="download-container" markdown="1">
### Chrome Extension

**Version:** CHROME_VERSION

[Download for Chrome](CHROME_DOWNLOAD_URL){: .btn .btn-primary }
</div>

<small>Last updated: BUILD_DATE</small>

## Building Extensions

The extension has one shared runtime source and two generated manifest projections. Build both variants with:

```bash
bun run build-extension
```

The command builds the runtime once and creates:

- `ext/build-ch`: unpacked Chromium extension with a service-worker background.
- `ext/feedfathom_ch.zip`: Chromium upload/distribution archive.
- `ext/build-ff`: unpacked Firefox extension with a scripts background and Gecko metadata.
- `ext/feedfathom_ff.zip`: unsigned archive for temporary local testing only.

Both lowercase ZIP archives are unsigned build artifacts. `bun run build-project` also runs this extension build alongside the application builds.

## Installation Instructions

### Firefox release

Use the Firefox download above. The published `.xpi` is signed by Mozilla through AMO's unlisted channel and receives self-hosted updates from this site.

### Firefox local build

1. Navigate to `about:debugging`.
2. Click "This Firefox" in the sidebar.
3. Click "Load Temporary Add-on".
4. Select `ext/build-ff/manifest.json` or the unsigned `ext/feedfathom_ff.zip`.

The unsigned ZIP is temporary-development input, not a production XPI.

### Chromium-based browsers

1. Navigate to `chrome://extensions/`.
2. Enable "Developer mode".
3. Click "Load unpacked".
4. Select `ext/build-ch`.

The Chromium ZIP is intended for store upload or extraction, not direct developer-mode loading.

## Publishing

The Pages workflow supplies one release version to both variants, signs `ext/build-ff` through AMO, and publishes only Mozilla's returned XPI. Repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` are required. The self-hosted update manifest uses the signed XPI's SHA-256 hash and the version and minimum Firefox version from the generated manifest.

## Features and Instance Configuration

Configure the extension with the FeedFathom instance's HTTP(S) origin only, with no path, query, or fragment (for example, `https://feeds.example.com`).

- **Feed discovery and subscription:** The extension detects feeds on the current website. With an instance configured, selecting a feed opens its web preview and subscription flow; after login, the browser returns to that preview. Without an instance, selecting a feed opens the feed directly.
- **Reader availability:** Reader and Reader plain modes are available in the web application only when the extension bridge is installed, available, and configured for that exact instance origin. Production instances must use HTTPS; HTTP is accepted only for loopback development. When the bridge is unavailable, Feed mode remains available.
- **Newsletter addresses:** The newsletter action opens a generated address in the web preview, where it can be copied. Newsletter ingestion requires `MAIL_ENABLED` and Cloudflare Email Routing through the bundled Worker to `/api/mail`. `MAILJET_API_KEY` and `MAILJET_API_SECRET` enable outbound activation emails for public registration; they do not receive newsletters.

[Next: Contributing](./contributing.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }

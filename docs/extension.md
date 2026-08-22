---
layout: default
title: Browser Extensions
nav_order: 3
---

# Browser Extensions

The extension detects feeds on the pages you visit and adds Reader modes to
the web application. It is optional; the web application works without it,
except for Reader modes.

## Download

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

## Configuration

Set the extension's instance setting to the FeedFathom instance's HTTP or
HTTPS origin, with no path, query, or fragment. For example,
`https://feeds.example.com`.

CAUTION: The origin must match the instance exactly. Reader modes check for
an extension bridge configured for that exact origin and fall back to Feed
mode when it does not match.

## Features

- **Feed discovery and subscription.** The extension detects feeds on the
  current site. With an instance configured, selecting a feed opens its web
  preview and subscription flow, and the browser returns to that preview
  after login. Without an instance configured, selecting a feed opens the
  feed itself.
- **Reader modes.** Reader and Reader plain are available in the web
  application only while the extension bridge is installed, available, and
  configured for that exact instance origin. Production instances must use
  HTTPS; HTTP is accepted only for loopback development. Feed mode remains
  available when the bridge is not.
- **Newsletter addresses.** The newsletter action opens a generated address
  in the web preview, where it can be copied. Ingestion requires
  `MAIL_ENABLED` and Cloudflare Email Routing through the bundled Worker to
  `/api/mail`. `MAILJET_API_KEY` and `MAILJET_API_SECRET` enable outbound
  activation mail for public registration; they do not receive newsletters.

## Installation

### Firefox, released build

Use the Firefox download above. The published `.xpi` is signed by Mozilla
through AMO's unlisted channel and updates itself from this site.

### Firefox, local build

1. Navigate to `about:debugging`.
2. Select "This Firefox" in the sidebar.
3. Select "Load Temporary Add-on".
4. Select `ext/build-ff/manifest.json`, or the unsigned
   `ext/feedfathom_ff.zip`.

NOTE: The unsigned ZIP is development input only, not a production XPI. A
temporary add-on is removed when Firefox restarts.

### Chromium-based browsers

1. Navigate to `chrome://extensions/`.
2. Enable "Developer mode".
3. Select "Load unpacked".
4. Select `ext/build-ch`.

NOTE: The Chromium ZIP is intended for store upload or extraction, not for
loading directly in developer mode.

## Building

The extension has one shared runtime source and two generated manifest
projections. Build both variants:

```bash
bun run build-extension
```

The command builds the runtime once and produces:

| Artifact | Contents |
| --- | --- |
| `ext/build-ch` | Unpacked Chromium extension, service-worker background. |
| `ext/feedfathom_ch.zip` | Chromium upload and distribution archive. |
| `ext/build-ff` | Unpacked Firefox extension, scripts background and Gecko metadata. |
| `ext/feedfathom_ff.zip` | Unsigned archive, for temporary local testing only. |

Both ZIP archives are unsigned build artifacts. `bun run build-project` runs
this extension build alongside the application builds.

## Publishing

The Pages workflow supplies one release version to both variants, signs
`ext/build-ff` through AMO, and publishes only Mozilla's returned XPI.
Repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` are required. The
self-hosted update manifest uses the signed XPI's SHA-256 hash, together with
the version and minimum Firefox version from the generated manifest.

[Next: Contributing](./contributing.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }

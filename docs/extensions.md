---
layout: default
title: Browser Extensions
nav_order: 4
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

The browser extensions are built as part of the main build process:

```bash
bun run build-project
```

This builds both the application and the browser extensions. The build process creates:

- Zip files in the `build` directory: `FeedFathom_ff.zip` for Firefox and `FeedFathom_ch.zip` for Chromium
- Unpacked extension directories that are ready to use

If you want to build only the extensions without rebuilding the entire project, you can use:

```bash
bun run build-extension
```

## Installation Instructions

### Firefox

1. Navigate to `about:debugging`
2. Click "This Firefox" in the sidebar
3. Click "Load Temporary Add-on"
4. Select `FeedFathom_ff.zip` from the `ext` directory

### Chromium-based Browsers

1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `ext/build-ch` directory (the unpacked directory created during build)

## Features

- Feed detection on websites
- One-click subscription
- Newsletter email address generation
- API instance integration

[Next: Contributing](./contributing.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }

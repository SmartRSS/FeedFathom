---
layout: default
title: Browser Extensions
nav_order: 4
---

# Browser Extensions

## Building Extensions

To build the browser extensions:

```bash
bun run pack
```

This creates two zip files in the `dist` directory:
- `FeedFathom_ff.zip` for Firefox
- `FeedFathom_ch.zip` for Chromium

## Installation Instructions

### Firefox

1. Navigate to `about:debugging`
2. Click "This Firefox" in the sidebar
3. Click "Load Temporary Add-on"
4. Select `FeedFathom_ff.zip`

### Chromium-based Browsers

1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist_chromium` directory

## Features

- Feed detection on websites
- One-click subscription
- Newsletter email address generation
- API instance integration

[Next: Contributing](./contributing.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 } 
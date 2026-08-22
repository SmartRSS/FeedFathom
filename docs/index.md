---
layout: default
title: Home
nav_order: 1
---

# FeedFathom

FeedFathom is a self-hosted RSS and newsletter reader. It runs as a set of
containers on a single host and is reached through a browser. Companion
extensions for Firefox and Chromium add feed discovery and reader views.

## Quick start

Docker with Compose v2.24 or newer is the only requirement. The images are
published, so there is nothing to build and no registry to authenticate
against.

```bash
git clone https://github.com/SmartRSS/FeedFathom.git
cd FeedFathom
docker compose up -d
```

Open `http://127.0.0.1:3456` and create the first account. The database
schema is created and upgraded automatically on every start.

WARNING: Serve the instance over HTTPS. The session cookie carries the
`Secure` attribute, so plain HTTP on a non-local address produces a login
that appears to succeed and then fails silently.

## What it does

- **Feed management** — subscriptions organised into folders, updated by a
  dedicated background worker.
- **Browser extensions** — feed discovery on visited pages, plus Reader and
  Reader plain modes, for Firefox and Chromium-based browsers.
- **Newsletters** — per-user newsletter addresses, delivered through
  Cloudflare Email Routing and the bundled Worker to `/api/mail`. Optional.
- **Registration control** — closed by default, with optional Turnstile
  protection and Mailjet activation email.

## Built with

Bun, Elysia, Solid, PostgreSQL, and Redis, packaged as Docker images.

[Get started](./running.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/SmartRSS/FeedFathom){: .btn .fs-5 .mb-4 .mb-md-0 }

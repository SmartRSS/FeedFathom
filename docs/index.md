---
layout: default
title: Home
nav_order: 1
---

# FeedFathom

FeedFathom is an efficient RSS feed reader paired with an extension intended for use with both Firefox and Chromium-based browsers.

## Key Features

- **RSS Feed Management**: Efficiently manage and organize your RSS feeds
- **Browser Extensions**: Support for both Firefox and Chromium-based browsers
- **Newsletter Integration**: Unique newsletter addresses with inbound MIME delivery through Cloudflare Email Routing and the bundled Worker to `/api/mail`
- **Background Updates**: Automated feed updates via background workers
- **Activation Email**: Optional outbound Mailjet delivery for public-registration activation

## Technology Stack

FeedFathom leverages modern technologies for optimal performance:

- **Solid + Elysia**: For browser interfaces and server-side APIs
- **Bun**: Fast JavaScript runtime for server operations
- **Docker**: Containerized backend services for development and standalone deployment stacks
- **Background Workers**: For scheduled RSS feed updates
- **Cloudflare Email Routing**: For inbound newsletter delivery to `/api/mail` when `MAIL_ENABLED` is enabled

[Get Started](./running.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/SmartRSS/FeedFathom){: .btn .fs-5 .mb-4 .mb-md-0 }

# FeedFathom

FeedFathom is a self-hosted RSS and newsletter reader with companion extensions for Firefox and Chromium-based browsers.

## Components

- A Solid browser interface and Bun-native Elysia API
- A background worker for scheduled feed updates
- Firefox and Chromium extensions for feed discovery, subscription, and Reader modes
- A Cloudflare Email Routing Worker for inbound newsletters

## Quick Start

Prerequisites are [Bun](https://bun.sh), Docker with Docker Compose, and access to the Docker Hardened Images registry.

```bash
docker login dhi.io
bun install --frozen-lockfile
bun run dev
```

Open `http://127.0.0.1:3456`.

## Quality

Run the complete test, lint, type-check, and build gate:

```bash
bun run quality
```

## Browser Extension Builds

```bash
bun run build-extension
```

This creates the unpacked extensions in `ext/build-ch` and `ext/build-ff`, plus the lowercase archives `ext/feedfathom_ch.zip` and `ext/feedfathom_ff.zip`. See the extension documentation for local installation and Firefox signing details.

## Documentation

- [Running and deployment](docs/running.md)
- [Browser extensions](docs/extension.md)
- [Contributing](docs/contributing.md)

## License

FeedFathom is licensed under the MIT License.

## Acknowledgements

- [Remix Icon](https://remixicon.com/) — Apache License 2.0
- [Bun](https://bun.sh) — JavaScript runtime
- [Solid](https://www.solidjs.com/) and [Elysia](https://elysiajs.com/) — web UI and API framework

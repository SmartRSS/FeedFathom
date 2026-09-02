# FeedFathom

FeedFathom is a self-hosted RSS and newsletter reader. It runs as a set of
containers on a single host and is reached through a browser. Companion
extensions for Firefox and Chromium add feed discovery and reader views.

The database schema is created and upgraded automatically on every start.
There is no manual database step, on a first install or on an upgrade.

## Components

| Component | Function |
| --- | --- |
| Server | Serves the web interface and the API. |
| Worker | Fetches and parses feeds on a schedule. |
| Migrator | Brings the database schema up to date, then exits. Runs on every start. |
| PostgreSQL | Stores accounts, subscriptions, and articles. |
| Redis | Holds the job queue and the HTTP cache. |
| Browser extension | Discovers feeds on visited pages and renders reader views. Optional. |
| Cloudflare Email Worker | Relays inbound newsletters to the API. Optional. |

## Self-hosting

Docker with Compose v2.24 or newer is the only requirement. The images are
published, so there is nothing to build and no registry to authenticate
against.

```bash
git clone https://github.com/SmartRSS/FeedFathom.git
cd FeedFathom
docker compose up -d
```

Open `http://127.0.0.1:3456` and create the first account. The first account
can always be created. Afterwards, registration stays closed unless
`ENABLE_REGISTRATION` is `true`.

Configure the deployment by putting variables in a `.env` file next to
`compose.yml`. Copy `.env.example` to start from the documented defaults.
[Running and deployment](docs/running.md) explains the ones worth setting.

### Serving over the network

WARNING: Serve the instance over HTTPS. The session cookie carries the
`Secure` attribute, which browsers refuse to store on an insecure origin, so
plain HTTP on a non-local address produces a login that appears to succeed
and then fails silently on the next request. Browsers exempt `localhost`
from this rule. Bare IP addresses are not exempt.

Restrict the published port to loopback and terminate TLS in front of it. Set
`FEEDFATHOM_PORT=127.0.0.1:3456` in `.env`, then point a reverse proxy at it.
A complete Caddyfile, which gets and renews a certificate on its own:

```caddy
feeds.example.com {
	reverse_proxy 127.0.0.1:3456
}
```

Any reverse proxy works. The requirements are TLS termination, forwarding to
the published port, and passing the original `Host` header through. No path
rewriting or WebSocket handling is needed.

### Upgrading

CAUTION: Migrations are forward-only. A newer image will not downgrade a
database it has already migrated. Back up before upgrading, and pin
`FEEDFATHOM_TAG` to a commit SHA to control when the upgrade happens.

```bash
docker compose pull
docker compose up -d
```

### Backup

Everything irreplaceable is in PostgreSQL. Redis holds queue state and cached
responses.

```bash
docker compose exec -T postgres pg_dump -U postgres postgres > feedfathom-backup.sql
```

## Development

Development also requires [Bun](https://bun.sh) and Git.

```bash
bun install --frozen-lockfile
bun run dev
```

This starts `compose.yml` with the `deploy/compose.dev.yml` overlay and runs
Vite on the host. Open `http://127.0.0.1:3456`.

Run the complete gate before opening a pull request. It covers unit tests,
real Chromium tests, formatting, linting, type checking, and every build
target.

```bash
bun run quality
```

## Browser extension

The extension adds feed discovery on visited pages and reader views. Reader
views work only through the extension. The server does not proxy article
pages.

```bash
bun run build-extension
```

This creates the unpacked extensions in `ext/build-ch` and `ext/build-ff`,
plus the archives `ext/feedfathom_ch.zip` and `ext/feedfathom_ff.zip`. See
the [extension documentation](docs/extension.md) for local installation and
Firefox signing details.

## Newsletters

Newsletter ingestion uses Cloudflare Email Routing and the bundled Worker,
which relays messages to `/api/mail`. The stack runs no SMTP server and does
not expose port 25.

Set `MAIL_ENABLED=true` and set `MAIL_RELAY_SECRET` to the same value
configured on the Cloudflare Worker. Outbound activation email for public
registration is separate and needs `MAILJET_API_KEY` and
`MAILJET_API_SECRET`.

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

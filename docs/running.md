---
layout: default
title: Running the Application
nav_order: 2
---

# Running FeedFathom

## Development Server

Development requires Bun, Git, Docker with Docker Compose, and access to the Docker Hardened Images registry. Clone the repository and install the host dependencies:

```bash
git clone https://github.com/SmartRSS/FeedFathom.git
cd FeedFathom
bun install --frozen-lockfile
```

Authenticate without storing registry credentials in the repository; `docker login dhi.io` prompts for them securely. Start Docker, then run:

```bash
docker login dhi.io
bun run dev
```

The command builds and waits for the standalone development stack in `deploy/compose.dev.yml` before starting host Vite in the foreground. Open `http://127.0.0.1:3456`. Backend source is mounted read-only; frontend changes use native host file watching. The default PostgreSQL role, password, and database are all `postgres`, and the generated container `DATABASE_URL` matches them. If you override `POSTGRES_USER`, `POSTGRES_PASSWORD`, or `POSTGRES_DB`, the generated URL follows those values unless you supply `DATABASE_URL` explicitly.

Press Ctrl-C to stop Vite and the development containers while preserving database and Redis volumes. If startup is interrupted, run the idempotent `bun run dev:down`; it does not remove volumes. Backend logs remain available with:

```bash
docker compose -f deploy/compose.dev.yml logs -f
```

A changed `package.json` or `bun.lock` is installed on the host with `bun install --frozen-lockfile` and incorporated into the development image when `bun run dev` rebuilds it.

## Release Image Smoke Test

There is intentionally no default Compose file in the repository root. `deploy/compose.smoke.yml` is a standalone, isolated stack for checking the release server, worker, and migrator images with PostgreSQL and Redis. To smoke an already-published release, supply its full immutable commit SHA, pull that exact image set, and prevent Compose from rebuilding or pulling during startup:

```bash
export FEEDFATHOM_TAG=0123456789abcdef0123456789abcdef01234567
docker compose -f deploy/compose.smoke.yml pull
docker compose -f deploy/compose.smoke.yml up -d --wait --wait-timeout 300 --no-build --pull never
```

The server binds only to loopback. Set `FEEDFATHOM_SMOKE_PORT` before startup when port `3456` is already in use.

The same file contains release-target build definitions for internal pull-request verification. To reproduce that path locally, authenticate to `dhi.io`, set `FEEDFATHOM_TAG` to the exact local commit SHA, pull only PostgreSQL and Redis, build all three application targets, and start them without allowing an image pull:

```bash
docker login dhi.io
export FEEDFATHOM_TAG="$(git rev-parse HEAD)"
docker compose -f deploy/compose.smoke.yml pull redis postgres
docker compose -f deploy/compose.smoke.yml build migrator server worker
docker compose -f deploy/compose.smoke.yml up -d --wait --wait-timeout 300 --no-build --pull never
```

## Production Deployment

`deploy/stack.yml` is the proxy-neutral single-node Swarm definition. It creates the application and data services but publishes no port and attaches no external ingress network. Operators can supply their own ingress layer; `deploy/stack.traefik.yml` is the optional Traefik integration used by this repository's production workflow:

```bash
docker stack config -c deploy/stack.yml
docker stack config -c deploy/stack.yml -c deploy/stack.traefik.yml
```

The Docker workflow calls the reusable quality workflow before every event-specific job. Fork pull requests run quality only. Internal pull requests then authenticate only to `dhi.io`, build/load all three `linux/amd64` release targets, and smoke the exact local SHA without pulling application images. A main push publishes only multi-platform full-SHA manifests, smokes that exact SHA, and promotes each verified manifest to `latest` only after smoke succeeds. Manual dispatch accepts exactly one 40-character lowercase hexadecimal `deploy_tag`; it verifies all three existing manifests, checks out the smoke and stack definitions from that same commit, and smokes them without rebuilding or retagging. There are no branch image tags.

The protected `production` GitHub environment deploys both stack files only when the repository variable `ENABLE_SWARM_DEPLOYMENT` is exactly `true`. Main-push deployment additionally requires successful `latest` promotion; manual deployment uses the same verified `deploy_tag` and does not update `latest`. The production stack defaults to `1` server replica (`APP_REPLICAS`) and `10` worker replicas (`WORKER_REPLICAS`). All three standalone deployment files set worker concurrency to `25`, lock duration to `60` seconds, cleanup interval to `20` seconds, and job-gathering interval to `20` seconds. These deployment values, rather than the bare-process fallbacks in `src/config.ts`, are authoritative for the supported Docker workflows.

### Sizing for a smaller host

`stack.yml` defaults are deliberately generous (sized for a host with room to spare, not for a minimal footprint). To run on a smaller VPS, shrink these together rather than independently:

- `WORKER_CONCURRENCY` — max simultaneous feed-parses per worker replica; the bare-process fallback is `1`, and it's safe to run that low in production too.
- `DB_POOL_MAX` — Postgres connections opened per server/worker replica (default `10`, matching Bun's SQL client default).
- `POSTGRES_MAX_CONNECTIONS` — Postgres's own connection ceiling (`stack.yml` default `1000`, far more than a small deployment needs). Size it against the other two: roughly `1.5 * (APP_REPLICAS + WORKER_REPLICAS) * DB_POOL_MAX`, which leaves room for connection churn during a rolling update without reserving memory for thousands of unused slots. For example, 1 server + 1 worker replica at the `DB_POOL_MAX` default of `10` needs `1.5 * 2 * 10 = 30`.

Before the first cutover, keep that gate disabled and complete these operator-owned steps:

1. Back up PostgreSQL and Redis, then record the actual existing volume names from `docker volume ls`. Set `POSTGRES_VOLUME_NAME` and `REDIS_VOLUME_NAME` to those exact names; do not infer them from the Compose keys and do not delete or recreate the volumes.
2. Initialize this host as the single-node Swarm manager with `docker swarm init` if it is not already a manager.
3. If using the optional Traefik layer, configure Traefik's Swarm provider and attach it to an external overlay network. Set `TRAEFIK_NETWORK_NAME` to that network's exact name. The old standalone Docker provider and bridge network are not sufficient.
4. Configure the protected environment with `STACK_NAME`, `FEED_FATHOM_DOMAIN`, app/worker replica and resource values, mail and Turnstile values, the SSH credentials, and an exact `SSH_KNOWN_HOSTS` entry obtained through a trusted channel. Add `DATABASE_URL` as a protected secret. Its PostgreSQL role, password, host, and database must match the initialized volume. The stack initializes new volumes with `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`, defaulting all three to `postgres`; for a nondefault installation, set the protected `POSTGRES_DB` variable and `POSTGRES_USER` and `POSTGRES_PASSWORD` secrets to the same database and credentials embedded in `DATABASE_URL`. Changing these initialization values does not change a database or credentials in an existing volume. Add `MAIL_RELAY_SECRET` as a protected secret with exactly the same value as the Cloudflare Email Worker secret. `FEED_FATHOM_DOMAIN` remains required application configuration for email identity and links even without Traefik. This workflow also selects the Traefik layer, so set `FEED_FATHOM_ALT_DOMAIN` and `TRAEFIK_NETWORK_NAME`. The deployment user must already be allowed to run Docker and pull the private GHCR images. The host must provide a coreutils-compatible `timeout` command with `-k` support.
5. Stop the old Compose project without removing volumes. Bootstrap the stack with application and worker replicas set to zero so Swarm creates the `${STACK_NAME}_backend` network and starts the existing PostgreSQL and Redis data:

   ```bash
   APP_REPLICAS=0 WORKER_REPLICAS=0 docker stack deploy \
     -c deploy/stack.yml \
     -c deploy/stack.traefik.yml \
     "$STACK_NAME"
   ```

   The direct article-uniqueness migration assumes this first-cutover isolation: the old Compose server and worker must remain stopped, and the Swarm server and worker replicas must remain zero until the protected migration finishes.

6. Enable `ENABLE_SWARM_DEPLOYMENT` and run the protected workflow to complete the cutover. It resolves the selected migrator image to a registry digest, creates one `${STACK_NAME}_migration` replicated job on the backend network with the protected `DATABASE_URL`, and updates server and worker services only after that task completes successfully. The completed job remains as a deployment lock until service convergence, exact-image checks, and a public `GET /` containing the stable `id="app"` SPA marker all pass. `/healthcheck` remains loopback-private for container health checks.

A migration failure leaves the existing application services untouched. If an interrupted deployment leaves `${STACK_NAME}_migration` behind, inspect it with `docker service ps --no-trunc "${STACK_NAME}_migration"` and `docker service logs "${STACK_NAME}_migration"`; remove it only after confirming that no deployment or migration is active. Database changes are forward-only and must follow expand/contract compatibility because a Swarm application rollback does not run a down migration.

The stack does not include an SMTP server or expose port 25. Newsletter ingestion uses Cloudflare Email Routing and the bundled Worker to relay MIME messages to `/api/mail`; set `MAIL_ENABLED=true` to enable newsletter subscriptions and ingestion. `MAILJET_API_KEY` and `MAILJET_API_SECRET` separately enable outbound activation email for public registration.

By default, registration is disabled for security reasons, with two exceptions:

1. The first account can always be created regardless of the registration setting
2. When `ENABLE_REGISTRATION` is set to `true`

After creating the first account, keep registration disabled unless the instance is intended to accept public registration.

## Building the Project

To build the project:

```bash
bun run build-project
```

This compiles TypeScript files and generates output in the `build` directory.

The build process consists of five parts that can be run individually:

```bash
# Build the server
bun run build-server

# Build the database migrator
bun run build-migrator

# Build the background worker
bun run build-worker

# Build the browser extensions
bun run build-extension

# Build the Cloudflare email Worker
bun run build-cloudflare-email-worker
```

## Development Workflow

`bun run dev` is the normal watch workflow. The individual processes are available for diagnostics:

```bash
bun run watch-spa
bun run watch-spa-api
bun run watch-worker
```

## Testing and Code Quality

Run the complete prerequisite before feature work or a pull request. It runs unit tests, real Chromium tests, formatting, Oxlint, TypeScript, Knip, and every production build target:

```bash
bun run quality
```

Migration integration tests are a separate destructive check and require a clearly disposable PostgreSQL database URL whose database name contains `test`, `migration_test`, or `disposable`:

```bash
MIGRATION_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/feedfathom_migration_test \
  bun run test:migrations
```

CI supplies one ephemeral PostgreSQL database as both `DATABASE_URL` and `MIGRATION_TEST_DATABASE_URL`, runs normal quality first, and then runs this migration check.

Focused commands are available while iterating:

```bash
bun run test:unit
bun run test:browser
bun run lint
bun run lint:fix
bun run build-project
```

Browser tests use real Chromium and retain traces and screenshots only for failures. Install Chromium once with `bunx playwright install chromium`; CI installs Chromium and its system dependencies automatically. To smoke an already-running production stack instead of starting Vite:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3456 bun run test:smoke
```

[Next: Browser Extensions](./extension.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }

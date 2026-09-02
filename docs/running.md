---
layout: default
title: Running the Application
nav_order: 2
---

# Running FeedFathom

## Deployment Files

`compose.yml` in the repository root is the entire deployment. Everything else is an overlay on it, so a variable, an image, or a health probe is defined exactly once, however the project runs.

```bash
docker compose up -d                                          # self-host
docker compose -f compose.yml -f deploy/compose.dev.yml up -d  # development
docker stack deploy -c compose.yml -c deploy/stack.yml NAME    # production
```

| File | Answers | Applied as |
| --- | --- | --- |
| `compose.yml` | How do I self-host this? | on its own |
| `deploy/compose.dev.yml` | How do I develop against it? | `-f compose.yml -f deploy/compose.dev.yml` |
| `deploy/compose.smoke.yml` | How does CI verify a release image? | `-f compose.yml -f deploy/compose.smoke.yml` |
| `deploy/stack.yml` | How does this repository run in production? | `-c compose.yml -c deploy/stack.yml` |

The three overlays are alternatives. Never combine them.

### What the Swarm loader costs the base file

`docker stack deploy` uses Docker's legacy Compose loader, which is far stricter than `docker compose`. Sharing one base file with it constrains three things in `compose.yml`. Each constraint is marked in place so it doesn't read as an arbitrary choice.

- **No top-level `name`.** It is rejected outright, so each Compose overlay names its own project instead. A plain `docker compose up -d` therefore takes its project name from the directory you cloned into.
- **No nested `${}` defaults.** Docker doesn't reject them — it silently mangles them into malformed values, so `DATABASE_URL`'s default stays flat and ignores `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. Change those, and set `DATABASE_URL` to match.
- **No long-form `depends_on`.** Only the list form survives, and Swarm ignores even that, so nothing in the file can express "start after migrations finish".

Startup ordering is handled in the application instead, so correctness does not depend on which orchestrator runs the containers.

Every build bundles `drizzle/meta/_journal.json`, so each binary knows the timestamp of the newest migration it was compiled against. The migrator writes that same timestamp to `drizzle.__drizzle_migrations`, in the same transaction that applies the migration. That lets `waitForMigration` (`src/platform/db/connection.ts`) ask an exact question at startup: *is the schema at the version I was built for?*

A plain check for a table's existence can't answer that question. `waitForMigration` can: it stays false mid-upgrade, and it stays true even against a database carrying migrations this build has never seen — which is what running an older image looks like.

Three pieces use it:

- The **migrator** retries its first connection for two minutes rather than exiting on the first refusal, so it can lose the race with PostgreSQL and still succeed.
- The **worker** opens its healthcheck port first, then waits. It reports healthy and idle while waiting, because nothing routes traffic to it and a crash loop would tell the orchestrator something untrue.
- The **server** does the opposite. It refuses to listen at all until its migration is applied, because accepting traffic against a schema it wasn't built for would answer requests with errors instead of making the orchestrator wait. Its healthcheck gets a 120-second `start_period` to cover the gap. A migration slower than that budget leaves the server restarting until it finishes — noisy, but self-correcting.

One thing to know before copying a command: `docker compose up --wait` reports the migrator's clean `exit(0)` as a failure, and naming services doesn't avoid it, since their dependencies get waited on too. Start first and wait second, naming only the services that stay up:

```bash
docker compose up -d
docker compose up -d --wait --wait-timeout 300 server worker
```

This loses nothing. Neither the server nor the worker can report healthy until the migration it needs has been applied, so waiting on them already waits on the migrator.

## Self-Hosting

Docker with Compose v2.24 or newer is the only requirement. There is nothing to build and no registry to authenticate against, because the server, worker, and migrator images are published on GHCR.

```bash
git clone https://github.com/SmartRSS/FeedFathom.git
cd FeedFathom
docker compose up -d
```

Open `http://127.0.0.1:3456` and create the first account right away — it's always allowed, regardless of the registration setting. After that, registration stays closed unless `ENABLE_REGISTRATION` is `true`. Leave it closed unless the instance is meant to accept public signups.

Configure the deployment with a `.env` file next to `compose.yml`. Every variable has a working default, so set only what you need to change — `.env.example` lists the ones a deployment normally touches, commented out. Pool sizes, poll intervals, and retention windows keep their defaults in `compose.yml` and `src/platform/config.ts`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FEEDFATHOM_TAG` | `latest` | Image tag to run. Pin a full commit SHA to control when you upgrade. |
| `FEEDFATHOM_PORT` | `3456` | Published port. Accepts a full binding, so `127.0.0.1:3456` restricts it to loopback for use behind a reverse proxy. |
| `FEED_FATHOM_DOMAIN` | `localhost:3456` | Public host. Newsletter addresses and email links are built from it. |
| `POSTGRES_PASSWORD` | `postgres` | PostgreSQL password. PostgreSQL is never published outside the Compose network, but change it if that reassurance is not enough. Set `DATABASE_URL` to match — the default does not follow it. |
| `DATABASE_URL` | built from the defaults above | Connection URL the application uses. Only needed if you change any `POSTGRES_*` value or point at an external database. |
| `REDIS_URL` | `redis://redis:6379` | Redis the job queue and the HTTP cache live in. Only needed to point at a Redis you already run; `rediss://` is accepted for TLS. |
| `ENABLE_REGISTRATION` | `false` | Whether accounts beyond the first may be created. |
| `MAIL_ENABLED` | `false` | Whether newsletter subscription and ingestion are available. Requires `MAIL_RELAY_SECRET`. |
| `MAIL_DOMAIN` | `FEED_FATHOM_DOMAIN` | Domain inbound newsletter mail is routed to. Generated addresses are minted at this host, so set it whenever mail lands on a different domain than the app is served from. |
| `WORKER_CONCURRENCY` | `25` | Simultaneous feed parses. Lower it on a small host; `1` is safe. |

### Behind a reverse proxy

WARNING: Serve the instance over HTTPS. The session cookie carries the `Secure` attribute, which browsers refuse to store on an insecure origin. Plain HTTP on a non-local address makes login appear to succeed, then fail silently on the next request. Browsers exempt `localhost` from this rule. Bare IP addresses are not exempt.

`FEEDFATHOM_PORT` accepts a full binding, so restrict the published port to loopback and terminate TLS in front of it:

```bash
FEEDFATHOM_PORT=127.0.0.1:3456
```

A complete Caddyfile, which gets and renews a certificate on its own:

```caddy
feeds.example.com {
	reverse_proxy 127.0.0.1:3456
}
```

Any reverse proxy works. The requirements are TLS termination, forwarding to the published port, and passing the original `Host` header through. No path rewriting or WebSocket handling is needed.

NOTE: Some proxies replace `Host` with the upstream address by default, nginx among them. That does not break the application, but a subscription's stored home link falls back to the upstream address instead of the public host name.

`/healthcheck` answers the container health probes and returns 403 to outside callers, so it is not usable as a proxy health probe.

The stack runs no SMTP server and exposes no port 25. Inbound newsletters arrive through Cloudflare Email Routing and the bundled Worker, which relays MIME messages to `/api/mail`. `MAIL_RELAY_SECRET` must match the secret configured on that Worker. Outbound activation email for public registration is separate and needs `MAILJET_API_KEY` and `MAILJET_API_SECRET`.

Upgrading pulls the new images and reruns migrations, which are forward-only:

```bash
docker compose pull
docker compose up -d
```

`docker compose down` stops everything and keeps both volumes: `postgres_storage_17` and `redis_storage`, which is what a backup needs to cover. Compose prefixes them with the project name. Since `compose.yml` can't declare one (see above), that prefix defaults to the directory you cloned into — pin it by adding `COMPOSE_PROJECT_NAME=feedfathom` to `.env` if you'd rather the volume names not depend on the folder name.

## Development

Development also requires Bun and Git.

```bash
bun install --frozen-lockfile
bun run dev
```

Open `http://127.0.0.1:3456`. `bun run dev` builds and starts `compose.yml` plus `deploy/compose.dev.yml`, waits for the server and worker to report healthy, then runs Vite on the host in the foreground. Ctrl-C stops both and keeps the volumes. If startup is interrupted, run the idempotent `bun run dev:down` to clean up without removing them.

The overlay changes three things:

- The three published images become one image, built from the checkout.
- `src` is mounted read-only into each service, so `bun --watch` reloads the backend on save. The frontend uses Vite's native host file watching instead.
- The published port moves to `127.0.0.1:3001`, freeing `3456` for Vite, which proxies `/api` to the container.

Backend logs come from the same pair of files:

```bash
docker compose -f compose.yml -f deploy/compose.dev.yml logs -f
```

A changed `package.json` or `bun.lock` is installed on the host with `bun install --frozen-lockfile` and folded into the development image the next time `bun run dev` rebuilds it.

## Release Image Smoke Test

The smoke overlay boots the release images and runs a real Chromium test against them. It is what catches an image that builds but cannot start, migrate, or render. Running it through `compose.yml` is deliberate: the file under test is the one self-hosters run.

To smoke a published release, supply its full immutable commit SHA and forbid any rebuild or pull during startup:

```bash
export FEEDFATHOM_TAG=0123456789abcdef0123456789abcdef01234567
docker compose -f compose.yml -f deploy/compose.smoke.yml pull
docker compose -f compose.yml -f deploy/compose.smoke.yml up -d --no-build --pull never
docker compose -f compose.yml -f deploy/compose.smoke.yml up -d --wait --wait-timeout 300 --no-build --pull never server worker
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3456 bun run test:smoke
```

Pull requests have nothing published to pull, so they build the three release targets from the checkout instead and tag them with the local commit SHA. Everything after that is identical:

```bash
export FEEDFATHOM_TAG="$(git rev-parse HEAD)"
docker compose -f compose.yml -f deploy/compose.smoke.yml pull redis postgres
docker compose -f compose.yml -f deploy/compose.smoke.yml build migrator server worker
docker compose -f compose.yml -f deploy/compose.smoke.yml up -d --no-build --pull never
docker compose -f compose.yml -f deploy/compose.smoke.yml up -d --wait --wait-timeout 300 --no-build --pull never server worker
```

The overlay uses its own project name, so a smoke run never touches a self-hosted stack's containers or volumes on the same machine. It also makes `FEEDFATHOM_TAG` mandatory, because a smoke test that quietly fell back to `latest` would verify the wrong artifact.

## Production Deployment

`deploy/stack.yml` is this repository's single-node Docker Swarm overlay, not the recommended way to self-host (`compose.yml` is). Swarm buys rolling updates with automatic rollback, replica counts, and CPU and memory reservations, at the cost of external volumes, protected secrets, and a migration job that runs as a deployment lock.

The overlay adds only what Swarm needs and Compose has no concept of: replica counts, rollout and rollback policy, worker resource limits, and the fact that the data volumes already exist on the host. Images, environment, ports, and health probes all come from `compose.yml`. Validate the pair before deploying:

```bash
docker stack config -c compose.yml -c deploy/stack.yml
```

`docker stack deploy` prints `Ignoring unsupported options: restart` for the base file's `restart: always`. That's expected — `deploy.restart_policy` in the overlay governs restarts under Swarm instead. The migrator is pinned to zero replicas, because Swarm would otherwise restart a completed migration forever. Production instead runs migrations as a separate replicated-job service that doubles as a deployment lock.

The port comes from `FEEDFATHOM_PORT`, which the deployment workflow sets from the protected `SERVER_HOST_PORT` variable. Anything in front of that port — TLS termination, a reverse proxy, an ingress network — is the operator's to supply, and the stack makes no assumptions about it.

The Docker workflow calls the reusable quality workflow before every event-specific job:

- **Fork pull requests** run quality only.
- **Internal pull requests** build and load all three `linux/amd64` release targets from the checkout, then smoke the exact local SHA without pulling application images.
- **A main push** publishes multi-platform full-SHA manifests, smokes that exact SHA, and promotes each verified manifest to `latest` only after smoke succeeds.
- **Manual dispatch** accepts exactly one 40-character lowercase hexadecimal `deploy_tag`. It verifies all three existing manifests, checks out the smoke and stack definitions from that same commit, and smokes them without rebuilding or retagging.

There are no branch image tags.

The protected `production` GitHub environment deploys the stack only when the repository variable `ENABLE_SWARM_DEPLOYMENT` is exactly `true`. A main-push deployment also requires successful `latest` promotion. Manual deployment uses the same verified `deploy_tag` and doesn't update `latest`. The production stack defaults to `1` server replica (`APP_REPLICAS`) and `10` worker replicas (`WORKER_REPLICAS`).

### Sizing for a smaller host

The Swarm defaults assume a host with room to spare. On a smaller VPS, shrink these together rather than independently:

- `WORKER_CONCURRENCY` — max simultaneous feed parses per worker replica. The bare-process fallback is `1`, and it's safe to run that low in production too.
- `DB_POOL_MAX` — PostgreSQL connections opened per server and worker replica (default `10`, matching Bun's SQL client default).
- `POSTGRES_MAX_CONNECTIONS` — PostgreSQL's own connection ceiling (`deploy/stack.yml` default `1000`, far more than a small deployment needs). Size it against the other two: roughly `1.5 * (APP_REPLICAS + WORKER_REPLICAS) * DB_POOL_MAX`, which leaves room for connection churn during a rolling update without reserving memory for thousands of unused slots. One server and one worker replica at the `DB_POOL_MAX` default of `10` needs `1.5 * 2 * 10 = 30`.

### The squashed migration baseline

The 31 historical migrations were replaced by a single baseline,
`drizzle/0000_silky_multiple_man.sql`. It builds the same schema those 31
produced, so a database that ran them needs no schema change.

The one-time shim that stamped such a database as having applied the baseline
has been removed, so a database that never took the squash upgrade can no
longer take it at all: the baseline would be replayed and fail on
`CREATE TABLE`. That failure is safe — the transaction rolls back and the
journal is untouched — but the only way forward is to reach the squash under
an image that still carried the shim.

One consequence is permanent. The legacy `job_queue` table, created by the old
migrations 0008 to 0010 and unused since the move to BullMQ, survives on any
database that predates the squash and is absent from every fresh install. No
migration or schema file mentions it any more.

### First cutover

Keep `ENABLE_SWARM_DEPLOYMENT` disabled and complete these operator-owned steps first.

1. Back up PostgreSQL and Redis, then record the actual existing volume names from `docker volume ls`. Set `POSTGRES_VOLUME_NAME` and `REDIS_VOLUME_NAME` to those exact names. Do not infer them from the Compose keys, and do not delete or recreate the volumes.
2. Initialize this host as the single-node Swarm manager with `docker swarm init` if it is not already a manager.
3. Configure the protected environment:
   - `STACK_NAME`, `FEED_FATHOM_DOMAIN`, `SERVER_HOST_PORT`, app and worker replica and resource values, mail and Turnstile values, the SSH credentials, and an exact `SSH_KNOWN_HOSTS` entry obtained through a trusted channel.
   - `DATABASE_URL` as a protected secret. Its PostgreSQL role, password, host, and database must match the initialized volume.
   - The stack initializes new volumes with `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`, all defaulting to `postgres`. For a nondefault installation, set the protected `POSTGRES_DB` variable and the `POSTGRES_USER`/`POSTGRES_PASSWORD` secrets to the same database and credentials embedded in `DATABASE_URL`. Changing these initialization values does not change a database or credentials already in an existing volume.
   - `MAIL_RELAY_SECRET` as a protected secret, matching the Cloudflare Email Worker secret exactly. `FEED_FATHOM_DOMAIN` is required regardless of how ingress is arranged, since email identity and links are built from it.
   - The deployment user must already be allowed to run Docker, and the host must provide a coreutils-compatible `timeout` with `-k` support.
4. Stop the old Compose project without removing volumes. Bootstrap the stack with application and worker replicas set to zero, so Swarm creates the `${STACK_NAME}_backend` network and starts the existing PostgreSQL and Redis data:

   ```bash
   APP_REPLICAS=0 WORKER_REPLICAS=0 docker stack deploy \
     -c compose.yml \
     -c deploy/stack.yml \
     "$STACK_NAME"
   ```

   The direct article-uniqueness migration assumes this first-cutover isolation: the old Compose server and worker must remain stopped, and the Swarm server and worker replicas must remain zero until the protected migration finishes.

5. Enable `ENABLE_SWARM_DEPLOYMENT` and run the protected workflow to complete the cutover. It resolves the selected migrator image to a registry digest, creates one `${STACK_NAME}_migration` replicated job on the backend network with the protected `DATABASE_URL`, and updates server and worker services only after that task completes successfully. The completed job remains as a deployment lock until service convergence, exact-image checks, and a public `GET /` containing the stable `id="app"` SPA marker all pass. `/healthcheck` stays loopback-private for container health probes.

A migration failure leaves the existing application services untouched. If an interrupted deployment leaves `${STACK_NAME}_migration` behind, inspect it with `docker service ps --no-trunc "${STACK_NAME}_migration"` and `docker service logs "${STACK_NAME}_migration"`, and remove it only after confirming that no deployment or migration is active. Database changes are forward-only and must follow expand/contract compatibility, because a Swarm application rollback does not run a down migration.

## Building the Project

`bun run build-project` writes every target to `build/`. The five parts also
run individually:

```bash
bun run build-server
bun run build-migrator
bun run build-worker
bun run build-extension
bun run build-cloudflare-email-worker
```

### Deploying the Cloudflare email Worker

CI owns this. The `deploy_email_worker` job in `.github/workflows/docker-build.yml`
runs after the Swarm deploy on `main`, builds the bundle, and uploads it only
when its content hash differs from the `content:` tag on the deployed script.
Do not upload by hand: it leaves the tag pointing at content that is no longer
there, which is how the Worker spent four months as a stale dashboard-edited
script.

It runs after `deploy`, never beside it: the relay wire format is a contract
between the Worker and `/api/mail`, so a Worker deployed against a server that
has not rolled yet bounces every message.

Configuration, all on the repository rather than the `production` environment:

| Name | Kind | Purpose |
| --- | --- | --- |
| `EMAIL_WORKER_SCRIPT` | variable | Worker script name. Empty disables the job. |
| `EMAIL_WORKER_ACCOUNT_ID` | variable | Cloudflare account the script lives in. |
| `MAIL_ENDPOINT_DOMAIN` | variable | Origin the Worker relays to, e.g. `https://feeds.example.com`. |
| `CLOUDFLARE_API_TOKEN` | secret | Needs only *Workers Scripts* read and write on that one account. |
| `MAIL_RELAY_SECRET` | secret | The same value the server reads. |

The hash covers the endpoint and the secret as well as the bundle, so rotating
`MAIL_RELAY_SECRET` or repointing `MAIL_ENDPOINT_DOMAIN` redeploys the Worker
on the next run without any change to the code.

Two invariants the job depends on, and that a manual upload would break:
every binding must be sent on every upload, because the API replaces the whole
set rather than merging into it. And `MAIL_ENDPOINT_DOMAIN` must be an origin
only — no path, no credentials — and `https://` unless the host is loopback,
because the relay secret and the entire message travel in that request.

Cloudflare Email Routing itself is configured outside this repository and
needs a **catch-all rule** on the mail domain whose action is *Send to a
Worker* pointing at this script. Newsletter addresses are minted client-side
at random, so per-address rules cannot work.

The bundle exports an `email` handler and nothing else, so a `GET` against the
script's `workers.dev` URL answering `error code: 1101` is the expected healthy
state.

## Testing and Code Quality

`bun run dev` is the normal watch workflow. `watch-spa`, `watch-spa-api`, and
`watch-worker` run the individual processes for diagnostics.

Run the full gate before feature work or a pull request. It covers unit tests,
real Chromium tests, formatting, Oxlint, TypeScript, Knip, and every production
build target:

```bash
bun run quality
```

The PostgreSQL integration tests (`*-integration.test.ts`) are a separate destructive check and require a clearly disposable database URL whose database name contains `test`, `migration_test`, or `disposable`:

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

Browser tests use real Chromium and retain traces and screenshots only for failures. Install Chromium once with `bunx playwright install chromium` — CI installs Chromium and its system dependencies automatically. To smoke an already-running production stack instead of starting Vite:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3456 bun run test:smoke
```

[Next: Browser Extensions](./extension.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }

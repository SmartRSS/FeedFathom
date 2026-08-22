---
layout: default
title: Running the Application
nav_order: 2
---

# Running FeedFathom

## Deployment Files

`compose.yml` in the repository root is the entire deployment. Everything else is an overlay on it, so a variable, an image, or a health probe is defined exactly once no matter how the project is being run.

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

The three overlays are alternatives and are never combined with one another.

### What the Swarm loader costs the base file

`docker stack deploy` still uses Docker's legacy Compose loader, which is far stricter than `docker compose`. Sharing one base file with it constrains three things in `compose.yml`, and each is marked in place so it does not read as an arbitrary choice.

- **No top-level `name`.** It is rejected outright, so each Compose overlay names its own project instead. A plain `docker compose up -d` therefore takes its project name from the directory you cloned into.
- **No nested `${}` defaults.** They are not rejected, they are silently mangled into malformed values, so `DATABASE_URL`'s default is flat and does not follow `POSTGRES_USER`, `POSTGRES_PASSWORD`, or `POSTGRES_DB`. Change those and you must set `DATABASE_URL` to match.
- **No long-form `depends_on`.** Only the list form survives, and Swarm ignores even that, so nothing in the file can express "start after migrations finish".

That last constraint is the interesting one, because startup ordering had been carrying real weight. It is now handled in the application instead, which is a better place for it: correctness no longer depends on which orchestrator is running the containers.

Every build bundles `drizzle/meta/_journal.json`, so each binary knows the timestamp of the newest migration it was compiled against. The migrator records that same timestamp in `drizzle.__drizzle_migrations` when it applies the migration, in the same transaction — so `waitForMigration` in `src/db/connection.ts` can ask an exact question at startup: *is the schema at the version I was built for?* It stays false midway through an upgrade, which probing for a table's existence would not, and it stays true against a database carrying migrations this build has never heard of, which is what running an older image looks like.

Three pieces use it:

- The **migrator** retries its first connection for two minutes rather than exiting on the first refusal, so it can lose the race with PostgreSQL and still succeed.
- The **worker** opens its healthcheck port first, then waits. It reports healthy and idle while waiting, because nothing routes traffic to it and a crash loop would tell the orchestrator something untrue.
- The **server** does the opposite: it does not listen at all until its migration is applied, because accepting traffic against a schema it was not built for would answer requests with errors instead of making the orchestrator wait. Its healthcheck therefore gets a 30-second `start_period` to cover the gap. A migration slower than that budget leaves the server restarting until it finishes — noisy, but self-correcting.

One consequence is worth knowing before you copy a command: `docker compose up --wait` reports the migrator's clean `exit(0)` as a failure, and naming services does not avoid it, because their dependencies are waited on too. Start first and wait second, naming only the services that stay up:

```bash
docker compose up -d
docker compose up -d --wait --wait-timeout 300 server worker
```

Nothing is lost by narrowing it. Neither the server nor the worker can report healthy until the migration it needs has been applied, so waiting on them already waits on the migrator.

## Self-Hosting

Docker with Compose v2.24 or newer is the only requirement. There is nothing to build and no registry to authenticate against, because the server, worker, and migrator images are published on GHCR.

```bash
git clone https://github.com/SmartRSS/FeedFathom.git
cd FeedFathom
docker compose up -d
```

Open `http://127.0.0.1:3456`. Create the first account immediately: the first account can always be created regardless of the registration setting, and once it exists, registration stays closed unless `ENABLE_REGISTRATION` is `true`. Leave it closed unless the instance is meant to accept public signups.

Configure the deployment by putting variables in a `.env` file next to `compose.yml`. Every variable has a working default, so set only what you need to change; `.env.example` carries the whole list, commented out.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FEEDFATHOM_TAG` | `latest` | Image tag to run. Pin a full commit SHA to control when you upgrade. |
| `FEEDFATHOM_PORT` | `3456` | Published port. Accepts a full binding, so `127.0.0.1:3456` restricts it to loopback for use behind a reverse proxy. |
| `FEED_FATHOM_DOMAIN` | `localhost:3456` | Public host. Newsletter addresses and email links are built from it. |
| `POSTGRES_PASSWORD` | `postgres` | PostgreSQL password. PostgreSQL is never published outside the Compose network, but change it if that reassurance is not enough. Set `DATABASE_URL` to match — the default does not follow it. |
| `DATABASE_URL` | built from the defaults above | Connection URL the application uses. Only needed if you change any `POSTGRES_*` value or point at an external database. |
| `ENABLE_REGISTRATION` | `false` | Whether accounts beyond the first may be created. |
| `MAIL_ENABLED` | `false` | Whether newsletter subscription and ingestion are available. Requires `MAIL_RELAY_SECRET`. |
| `WORKER_CONCURRENCY` | `25` | Simultaneous feed parses. Lower it on a small host; `1` is safe. |

### Behind a reverse proxy

WARNING: Serve the instance over HTTPS. The session cookie carries the `Secure` attribute, which browsers refuse to store on an insecure origin, so plain HTTP on a non-local address produces a login that appears to succeed and then fails silently on the next request. Browsers exempt `localhost` from this rule; bare IP addresses are not exempt.

`FEEDFATHOM_PORT` accepts a full binding, so restrict the published port to loopback and terminate TLS in front of it:

```bash
FEEDFATHOM_PORT=127.0.0.1:3456
```

A complete Caddyfile, which obtains and renews a certificate on its own:

```caddy
feeds.example.com {
	reverse_proxy 127.0.0.1:3456
}
```

Any reverse proxy works. The requirements are TLS termination, forwarding to the published port, and passing the original `Host` header through. No path rewriting or WebSocket handling is needed.

NOTE: Some proxies replace `Host` with the upstream address by default, nginx among them. That does not break the application, but a subscription's stored home link falls back to the upstream address instead of the public host name.

`/healthcheck` answers the container health probes and returns 403 to outside callers, so it is not usable as a proxy health probe.

The stack runs no SMTP server and does not expose port 25. Inbound newsletters arrive through Cloudflare Email Routing and the bundled Worker, which relays MIME messages to `/api/mail`; `MAIL_RELAY_SECRET` must match the secret configured on that Worker. Outbound activation email for public registration is separate and needs `MAILJET_API_KEY` and `MAILJET_API_SECRET`.

Upgrading pulls the new images and reruns migrations, which are forward-only:

```bash
docker compose pull
docker compose up -d
```

`docker compose down` stops everything and keeps both volumes. Data lives in the `postgres_storage_17` and `redis_storage` volumes, which is what a backup needs to cover. Compose prefixes them with the project name, and `compose.yml` cannot declare one (see above), so that prefix is the directory you cloned into. Pin it by adding `COMPOSE_PROJECT_NAME=feedfathom` to `.env` if you would rather the volume names not depend on the folder name.

## Development

Development additionally requires Bun, Git, and access to the Docker Hardened Images registry, because the development image builds from `dhi.io` bases. Authenticate without storing credentials in the repository; `docker login dhi.io` prompts for them securely.

```bash
bun install --frozen-lockfile
docker login dhi.io
bun run dev
```

Open `http://127.0.0.1:3456`. `bun run dev` builds and starts `compose.yml` plus `deploy/compose.dev.yml`, waits for the server and worker to report healthy, then runs Vite on the host in the foreground. Ctrl-C stops both and preserves the volumes; if startup is interrupted, the idempotent `bun run dev:down` cleans up without removing them.

The overlay changes three things. The three published images become one image built from the checkout. `src` is mounted read-only into each service so `bun --watch` reloads the backend on save, while the frontend uses native host file watching through Vite. The published port moves to `127.0.0.1:3001`, which leaves `3456` for Vite, which proxies `/api` to the container.

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
docker login dhi.io
export FEEDFATHOM_TAG="$(git rev-parse HEAD)"
docker compose -f compose.yml -f deploy/compose.smoke.yml pull redis postgres
docker compose -f compose.yml -f deploy/compose.smoke.yml build migrator server worker
docker compose -f compose.yml -f deploy/compose.smoke.yml up -d --no-build --pull never
docker compose -f compose.yml -f deploy/compose.smoke.yml up -d --wait --wait-timeout 300 --no-build --pull never server worker
```

The overlay uses its own project name, so a smoke run never touches a self-hosted stack's containers or volumes on the same machine. It also makes `FEEDFATHOM_TAG` mandatory, because a smoke test that quietly fell back to `latest` would verify the wrong artifact.

## Production Deployment

`deploy/stack.yml` is this repository's single-node Docker Swarm overlay, and it is not the recommended way to self-host — `compose.yml` is. Swarm buys rolling updates with automatic rollback, replica counts, and CPU and memory reservations, at the cost of external volumes, protected secrets, and a migration job that has to run as a deployment lock. Reach for it only if you want that.

The overlay adds only what Swarm needs and Compose has no concept of: replica counts, rollout and rollback policy, worker resource limits, and the fact that the data volumes already exist on the host. Images, environment, ports, and health probes all come from `compose.yml`. Validate the pair before deploying:

```bash
docker stack config -c compose.yml -c deploy/stack.yml
```

`docker stack deploy` prints `Ignoring unsupported options: restart` for the base file's `restart: always`. That is expected; `deploy.restart_policy` in the overlay is what governs restarts under Swarm. The migrator is pinned to zero replicas, because Swarm would otherwise restart a completed migration forever — production runs migrations as a separate replicated-job service that doubles as a deployment lock.

The port comes from `FEEDFATHOM_PORT`, which the deployment workflow sets from the protected `SERVER_HOST_PORT` variable. Anything in front of that port — TLS termination, a reverse proxy, an ingress network — is the operator's to supply, and the stack makes no assumptions about it.

The Docker workflow calls the reusable quality workflow before every event-specific job. Fork pull requests run quality only. Internal pull requests then authenticate only to `dhi.io`, build and load all three `linux/amd64` release targets, and smoke the exact local SHA without pulling application images. A main push publishes only multi-platform full-SHA manifests, smokes that exact SHA, and promotes each verified manifest to `latest` only after smoke succeeds. Manual dispatch accepts exactly one 40-character lowercase hexadecimal `deploy_tag`; it verifies all three existing manifests, checks out the smoke and stack definitions from that same commit, and smokes them without rebuilding or retagging. There are no branch image tags.

The protected `production` GitHub environment deploys the stack only when the repository variable `ENABLE_SWARM_DEPLOYMENT` is exactly `true`. Main-push deployment additionally requires successful `latest` promotion; manual deployment uses the same verified `deploy_tag` and does not update `latest`. The production stack defaults to `1` server replica (`APP_REPLICAS`) and `10` worker replicas (`WORKER_REPLICAS`).

### Sizing for a smaller host

The Swarm defaults are deliberately generous, sized for a host with room to spare rather than for a minimal footprint. To run on a smaller VPS, shrink these together rather than independently:

- `WORKER_CONCURRENCY` — max simultaneous feed parses per worker replica; the bare-process fallback is `1`, and it is safe to run that low in production too.
- `DB_POOL_MAX` — PostgreSQL connections opened per server and worker replica (default `10`, matching Bun's SQL client default).
- `POSTGRES_MAX_CONNECTIONS` — PostgreSQL's own connection ceiling (`deploy/stack.yml` default `1000`, far more than a small deployment needs). Size it against the other two: roughly `1.5 * (APP_REPLICAS + WORKER_REPLICAS) * DB_POOL_MAX`, which leaves room for connection churn during a rolling update without reserving memory for thousands of unused slots. One server and one worker replica at the `DB_POOL_MAX` default of `10` needs `1.5 * 2 * 10 = 30`.

### The squashed migration baseline

The 31 historical migrations were replaced by a single baseline, `drizzle/0000_silky_multiple_man.sql`. It builds the same schema those 31 produced — verified by applying both to empty databases and comparing every column, type, default, nullability, index and constraint — so an existing database needs no schema change. It only needs to know the baseline's name for the schema it already has.

The migrator does that itself, so nothing manual is required. On a database whose journal records the final pre-squash migration, it inserts the baseline's row and skips it rather than replaying it:

```
Adopted migration baseline 0000_silky_multiple_man for a database that predates the squash
```

The rule is deliberately narrow. It fires only when the final pre-squash migration is journaled, which is what proves the database carries the complete old schema. A database stopped partway through the old history is left to fail on `CREATE TABLE` instead, because marking it migrated would claim a schema it does not have. That failure is safe: the transaction rolls back, the journal is untouched, and the deployment workflow leaves the running services alone.

It is also a no-op everywhere else. Fresh databases have no journal table, and databases that have already adopted the baseline carry its row.

Two consequences are permanent and worth recording.

The legacy `job_queue` table, created by the old migrations 0008 to 0010 and unused since the move to BullMQ, survives on any database that predates the squash and is absent from every fresh install. No migration or schema file mentions it any more.

Databases that never reached the final pre-squash migration cannot take this upgrade at all. They have to reach it under a pre-squash image first.

Once no database predating the squash remains, `adoptSquashedBaseline` in `src/migrator.ts` can be deleted.

### First cutover

Keep `ENABLE_SWARM_DEPLOYMENT` disabled and complete these operator-owned steps first.

1. Back up PostgreSQL and Redis, then record the actual existing volume names from `docker volume ls`. Set `POSTGRES_VOLUME_NAME` and `REDIS_VOLUME_NAME` to those exact names; do not infer them from the Compose keys and do not delete or recreate the volumes.
2. Initialize this host as the single-node Swarm manager with `docker swarm init` if it is not already a manager.
3. Configure the protected environment with `STACK_NAME`, `FEED_FATHOM_DOMAIN`, `SERVER_HOST_PORT`, app and worker replica and resource values, mail and Turnstile values, the SSH credentials, and an exact `SSH_KNOWN_HOSTS` entry obtained through a trusted channel. Add `DATABASE_URL` as a protected secret; its PostgreSQL role, password, host, and database must match the initialized volume. The stack initializes new volumes with `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`, defaulting all three to `postgres`; for a nondefault installation, set the protected `POSTGRES_DB` variable and the `POSTGRES_USER` and `POSTGRES_PASSWORD` secrets to the same database and credentials embedded in `DATABASE_URL`. Changing these initialization values does not change a database or credentials in an existing volume. Add `MAIL_RELAY_SECRET` as a protected secret with exactly the same value as the Cloudflare Email Worker secret. `FEED_FATHOM_DOMAIN` is required application configuration for email identity and links regardless of how ingress is arranged. The deployment user must already be allowed to run Docker, and the host must provide a coreutils-compatible `timeout` with `-k` support.
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

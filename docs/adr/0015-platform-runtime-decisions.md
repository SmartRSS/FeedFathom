# 0015 — Platform runtime: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Redis connections

### Bun's Redis client retries forever and reconnects from onclose

**Where:** `src/platform/runtime.ts`, the `RedisClient` options and its `onclose` handler

Once `maxRetries` runs out, Bun closes the client for good and every later command fails with "Connection has failed", even after Redis returns. With Bun's backoff capped at about 2 s, 100 retries outlast only a three-minute outage, after which login and every outbound fetch fail until a restart that the healthchecks never trigger. `maxRetries` is therefore the largest u32 Bun accepts, which retries forever. A connect attempt that times out closes the client regardless, and a partition drops packets so reconnects end that way, so `onclose` reconnects after one second; that reconnect is what lets the per-attempt `connectionTimeout` stay short.

### SUBSCRIBE runs on its own connection that never gives up on a command

**Where:** `src/platform/runtime.ts`, `createSubscriber()`

SUBSCRIBE takes over the connection it runs on, so subscribers get a connection of their own. It has no retry budget (`maxRetriesPerRequest: null`), so a SUBSCRIBE sent while Redis is down still lands once Redis is back.

### BullMQ gets a configured ioredis connection

**Where:** `src/platform/runtime.ts`, `bullmqRedis`

BullMQ requires `maxRetriesPerRequest: null` on its connection, so it is given a configured ioredis instance rather than the URL alone.

### The server listens for worker replies on its own connection, opened on first use

**Where:** `src/platform/runtime.ts`, `workerRequests`, `openWorkerRequestEvents()`, `closeWorkerRequestEvents()`

`QueueEvents` blocks on its connection, so it gets one from `createSubscriber`. Both processes import the runtime, and only the server waits for replies, so the listener and its connection open on the first request rather than at import; the worker never opens them. BullMQ does not close a connection it was handed, so shutdown closes the listener and then disconnects its connection. An unhandled `error` event on an `EventEmitter` throws, so the listener logs it instead.

### QUIT is bounded at shutdown

**Where:** `src/platform/runtime.ts`, `redisQuitTimeout`, `close()`

QUIT waits for Redis to answer. When an outage drops packets that answer never comes, and the open socket would hold shutdown until the orchestrator killed the process. After five seconds the connection is dropped instead; anything still queued on it could not have reached Redis anyway.

### Window counters are fixed windows set atomically in one Lua script

**Where:** `src/platform/redis-window-counter.ts`, `windowCountLua`, `countInWindow()`

Extends ADR 0004. The TTL is set when a counter first appears and the whole count expires together, which costs one key per window instead of one per hit. INCR and EXPIRE run in one script so no interruption can leave a counter without an expiry, and a key found with TTL -1 gets a fresh window. `windowCountLua` is exported as a Lua function so a caller's own script that gates one counter on another uses the same counting rule rather than a copy.

## Configuration

### A blank environment variable is unset

**Where:** `src/platform/config.ts`, `integerString()`, `optionalString()`, `configSchema`

`compose.yml` passes every variable through as `${X:-}`, so an unset variable arrives as an empty string and the defaults in `configSchema` are the only ones. A blank value decodes as unset, and optional strings are trimmed, so a blank one decodes to `undefined`. Treating "" as a value would override every default in a stock deployment.

### Durations are in seconds, and pruning settings are days on one activity clock

**Where:** `src/platform/config.ts`, `configSchema`

`LOCK_DURATION`, `CLEANUP_INTERVAL` and `GATHER_JOBS_INTERVAL` are seconds. `USER_DORMANT_AFTER_DAYS` is the days since a user's last request before they count as dormant for article pruning. `ARTICLE_STALE_AFTER_DAYS` is the days since an article was last seen in its feed before dormancy alone can prune it, so something published yesterday survives a dormant subscriber. `USER_EXPIRY_DAYS` deletes the account outright and is measured on the same last-activity timestamp, so dormancy is an earlier point on that clock, not a separate stateful event. 0 disables each of the three.

### FEEDFATHOM_BUILD is baked into the image

**Where:** `src/platform/config.ts`, `FEEDFATHOM_BUILD`; `Dockerfile`, `ARG FEEDFATHOM_BUILD`

The Dockerfile sets the commit an image was built from at build time, rather than the deployment supplying it, so it survives a moving tag such as `latest`. It is optional because a local build has no commit to claim.

### publicOrigin allows http only for loopback

**Where:** `src/platform/config.ts`, `AppConfig.publicOrigin`, `publicOrigin()`

`publicOrigin` is where mail links point. It is http only for loopback hosts, whose dev server has no certificate; every other host gets https.

### The newsletter address host drops the port and falls back to the app host

**Where:** `src/platform/config.ts`, `newsletterMailDomain()`

The address host is wherever inbound mail is routed, a separate deployment decision from where the app is served, so `MAIL_DOMAIN` wins and `FEED_FATHOM_DOMAIN` is only the single-domain fallback; it is undefined unless mail ingest is enabled. Either value may carry the public port for link building (localhost:3456 in dev), and an email address host never has one, so the port is stripped.

## Container images

### Build stages run on glibc

**Where:** `Dockerfile`, `installer`, `builder-base`

The SPA's compiler, `@solidjs/compiler`, ships no musl binary, and its WASI fallback does not load under Bun, so the build stages use the slim Debian image rather than Alpine. Only the build output reaches the release images.

### Release images run Bun with --no-addons

**Where:** `Dockerfile`, `release`, `ENTRYPOINT`

No server, worker or migrator bundle loads a native addon (bullmq's msgpackr falls back to its JavaScript codec), so denying `process.dlopen` and `bun:ffi`'s `cc()` costs nothing and takes a code-execution primitive away from any injected JavaScript. The `dev` stage keeps them, because Vite pulls in lightningcss, which is a real addon.

## Compose and Swarm

### compose.yml is written for Docker's legacy Swarm loader

**Where:** `compose.yml`, `x-database-env.DATABASE_URL`, every `depends_on`; the `name` in `deploy/compose.dev.yml` and `deploy/compose.smoke.yml`

`docker stack deploy` reads `compose.yml` with Docker's legacy Compose loader, which allows no top-level `name` (each Compose overlay names its project instead), no nested `${}` default and only short-form `depends_on`; `docs/running.md` lists the three. A nested default is not rejected but silently mangled into a malformed value, so `DATABASE_URL`'s default is flat and does not follow `POSTGRES_USER`, `POSTGRES_PASSWORD` or `POSTGRES_DB`. Short form orders starts, not readiness, so the migrator retries its first connection and the server and worker wait for the migrations journal (ADR 0014). The migrator is deliberately not a dependency of the server or worker: short form could not wait for it to finish, and `up --wait` would report its clean exit(0) as a failure.

### The PostgreSQL healthcheck runs a real query

**Where:** `compose.yml`, `postgres.healthcheck`

`pg_isready` reports success during the first-run bootstrap, while the server still listens only on its private socket. Following it with `SELECT 1` is what makes `--wait` mean ready for the migrator.

### The application healthcheck's start_period is a migration budget

**Where:** `compose.yml`, `x-app-healthcheck.start_period`

Neither application service reports healthy until the schema it was compiled against is applied (ADR 0020), so `start_period` covers a cold start plus an ordinary migration. It binds only a plain `docker compose up -d`, where the migrator and the application start together; the Swarm deploy migrates to completion first, so its tasks find the schema in place and go healthy in seconds. A migration too slow for the budget is a manual rollout: run the migrator to completion, then start or update the application services.

### The worker gets two minutes to stop

**Where:** `compose.yml`, `worker.stop_grace_period`

SIGTERM starts BullMQ's graceful close, which waits out the active job, and a start-first rollout stops a worker only after its replacement is healthy. Two minutes usually lets the job finish; if it does not, SIGKILL leaves the job stalled and BullMQ hands it to another worker, so it is not lost.

### Volumes and the network are declared without a driver

**Where:** `compose.yml`, `volumes`, `networks`; `deploy/stack.yml`

`deploy/stack.yml` marks the volumes external and switches the network to overlay, which a driver named in the base file would conflict with.

### The Swarm rollout monitor covers failures after a task reports healthy

**Where:** `deploy/stack.yml`, `update_config.monitor` of `server` and `worker`

Swarm does not count a task with a healthcheck as running until it reports healthy, the updater waits for that with no time limit, and a task that fails first counts as an update failure whatever `monitor` is (moby `daemon/cluster/executor/container/controller.go`, swarmkit `manager/orchestrator/update/updater.go`). So `monitor` does not have to cover the healthcheck's `start_period`: it bounds how long after going healthy a crash still triggers the rollback. Swarm waits it once after the last batch, and `docker stack deploy --detach=false` waits it again after the service converges, so every deploy pays it and it is kept short.

### Worker reservations leave room for a start-first batch

**Where:** `deploy/stack.yml`, `worker.deploy.resources.reservations`, `update_config.parallelism`

A start-first rollout runs each new task beside the one it replaces, so the node needs `parallelism` extra reservations of CPU beyond `WORKER_REPLICAS * WORKER_CPU_RESERVATION`. Without that headroom the new tasks cannot schedule until old ones stop, and old ones do not stop until the new ones are healthy, which deadlocks the rollout. Keep headroom when raising `WORKER_REPLICAS` or `parallelism` on a small node.

## Deploy script

### The deploy requires FEEDFATHOM_PORT

**Where:** `deploy/deploy.sh`, the check of `FEEDFATHOM_PORT`

`compose.yml` publishes the server on `FEEDFATHOM_PORT` and falls back to `3456` when it is empty. Production listens on its own port behind its proxy, so a missing variable would move it without a word; the script stops before it changes anything instead.

### Removing the migration job fails the deploy unless the job is gone

**Where:** `deploy/deploy.sh`, `remove_migration()`

The completed job service has been seen already gone when the cleanup runs, so a failed `docker service rm` is accepted when `docker service ls` no longer lists the service. Any other failure, such as an unreachable daemon, fails the deploy: a migration service left behind is the deployment lock, and the next deploy's `docker service create` would fail on its name, one deploy later and with no sign of the cause.

### The manager pulls only the migrator image

**Where:** `deploy/deploy.sh`, `docker pull "$MIGRATOR_IMAGE"`

The migrator is pulled only to pin its job service to an immutable digest. The nodes that run the server and worker pull those images themselves, with the credentials `--with-registry-auth` hands them, so pulling them on the manager too put hundreds of MB on the deploy's critical path.

### stack deploy runs with --quiet

**Where:** `deploy/deploy.sh`, `docker stack deploy --quiet --detach=false`

The per-task progress display redraws one line in place on a terminal, but under CI's non-TTY output it prints a fresh line many times a second and buries the rest of the log. `--quiet` does not change the waiting, which is `--detach=false`, and a failure still reports through the ERR trap's `diagnose()` dump and the image and public-root checks that follow.

### The public-root check asks for HTML

**Where:** `deploy/deploy.sh`, the `curl` of `http://${FEED_FATHOM_DOMAIN}/`

The server returns the SPA shell only to a request whose `Accept` header contains `text/html` (`wantsSpaShellFallback()` in `src/server-app.ts`), so curl's default `*/*` gets a 404 from a healthy production. The check sends the header a browser navigation sends.

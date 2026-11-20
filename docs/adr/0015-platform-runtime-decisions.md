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

# 0014 — Platform DB: design decisions recorded from the code

- **Status:** accepted
- **Date:** 2026-11-20

## Context

These decisions were written as comments next to the code they govern. When the
codebase stopped carrying comments (ADR 0023), each one moved here. Every entry
names the file and symbol it governs; read it before changing that code.

## Migrations

### Migrations opt indexes into a CONCURRENTLY pre-pass by how they are written

**Where:** `src/migrator.ts`, `concurrentIndexPattern`, `concurrentDropPattern`, `parseConcurrentIndexes()`, the pre-build and pre-drop loops; `src/__tests__/migrator.test.ts`

A plain `CREATE INDEX` blocks writes on a populated table until the migration transaction ends, and `DROP INDEX` waits for ACCESS EXCLUSIVE behind every running query and blocks every new one. A migration that writes `CREATE INDEX IF NOT EXISTS` or `DROP INDEX IF EXISTS` opts in: the migrator reads those statements out of the pending files and runs them `CONCURRENTLY` first, so the in-transaction statement finds the work done, and opting in is a matter of spelling rather than registration. The parser is split from the database work and pinned against a fixture as well as the real migration folder, because a pattern that silently stopped matching still leaves every index valid, just built the blocking way, which no schema assertion detects. If a migration fails after a pre-drop, the old schema runs without an index nothing needs any more.

### The concurrent pre-pass leaves dependent work to the migration and never keeps an invalid index

**Where:** `src/migrator.ts`, `dependsOnPendingMigration`, the pre-build and pre-drop loops

An index on a table that does not exist yet (a fresh database) is skipped, since building it in-transaction on an empty table costs nothing. A build failing with SQLSTATE class 42 depends on a pending migration (a missing column, table, function, operator class or extension) and is left for that migration, which reruns the same statement, so a real mistake still fails there. Every other error class stays fatal: a data error, deadlock, cancel or lost connection is no reason to fall back to the write-blocking build, and a data error is not something a pending migration fixes. An interrupted `CREATE INDEX CONCURRENTLY` leaves an INVALID index that `IF NOT EXISTS` would keep, so an existing invalid index is dropped before the build, and a class-42 failure mid-build is followed by a drop too. The pre-drop uses `IF EXISTS` because a fresh database never built the index and an earlier run may have dropped it.

### The migrator retries only its initial connection, on a fixed poll

**Where:** `src/migrator.ts`, `connectRetryDeadline`, `connectRetryInterval`

On a cold start the migrator routinely beats PostgreSQL to accepting connections, and Swarm arranges no start order at all; `compose.yml` and `deploy/stack.yml` both depend on the migrator surviving that race. It retries its first connection once a second for up to two minutes. Only the initial connection retries; a failure once migrating has started stays loud. The fixed poll is a known simplification: add backoff if a slow-starting PostgreSQL ever makes the log noise a real complaint.

### A failed advisory unlock is ignored

**Where:** `src/migrator.ts`, `migrateDatabase()`

A migration failing mid-transaction can leave the session unable to answer, and a throwing `pg_advisory_unlock` would replace the real error. The lock is session-scoped, so closing the reserved client releases it either way.

### The migration history starts at a squashed baseline

**Where:** `drizzle/0000_silky_multiple_man.sql`; `src/__tests__/migration-integration.test.ts`

There is no in-repo upgrade path from the pre-squash history. The only database that ran the old 31 migrations is production, which is stamped as having applied the baseline rather than running it. The tests check that the baseline builds the expected schema, that running it twice is a no-op, and that every later migration upgrades a populated baseline-era database without losing rows or state.

### The feed name migration decodes entities exactly once

**Where:** `drizzle/0014_plain_feed_names.sql`

Stored names are decoded one pass, as the parser does on import: `&#38;#39;` becomes `&#39;`, not `'`.

## Connections and startup

### Server and worker wait for the exact migration they were compiled against

**Where:** `src/platform/db/connection.ts`, `latestMigration`, `notReadyCodes`, `waitForMigration()`; `Dockerfile`, `builder-base`

A process can outrace the migrator on a cold start: Compose orders starts, not completion, and Swarm orders nothing. Without the wait the first query hits a missing schema and the process dies before opening its healthcheck port, which the orchestrator sees as a crash loop. The migrator writes one `drizzle.__drizzle_migrations` row per migration, keyed by the `when` timestamp from `drizzle/meta/_journal.json`; the journal is bundled into every build target, not only the migrator's (`builder-base` copies it in, and `bun build` inlines it, so nothing reads it at runtime), so checking for its newest entry is an exact "schema is at my version" test that stays false midway through an upgrade, which probing for a table would not. The wait is forever, with a throttled log, and covers only not-ready errors: 42P01, 57P03, and Bun's closed, refused and timed-out connection codes (Bun reports an unresolvable host as refused, which on Swarm can be a service not scheduled yet). A wrong password or a missing database is configuration and fails at once.

### The PostgreSQL pool bounds idle time and connection lifetime

**Where:** `src/platform/db/connection.ts`, `createDrizzleConnection()`

`idleTimeout` (60 s) and `maxLifetime` (30 min) recycle a dead connection, for example after a PostgreSQL restart, instead of letting it wedge the pool. Raise the bounds if connection churn ever shows up as a bottleneck.

## Articles

### articles.id is a bigserial

**Where:** `src/platform/db/schemas/articles.ts`, `articles.id`

Every upsert attempt burns a sequence value whether it inserts or conflicts, so the counter climbs by millions a day for a table of thousands of rows. A 32-bit serial had a dated end.

### A covering index makes the article list and unread recount index-only scans

**Where:** `src/platform/db/schemas/articles.ts`, `articles_source_published_covering_idx`

The index covers every column the article list and the unread recount read while deciding which rows qualify. Without it each candidate article (every visible one in the folder, not just the returned page) cost a heap page fetch, and a body-sized row fills a page: a 20-source folder read 27k heap pages per listing. The extra columns are trailing key columns rather than `INCLUDE` because drizzle has no builder for `INCLUDE`; the `(source_id, published_at)` prefix is what is searched and ordered on.

### The search vector column is a placeholder custom type with an unqualified expression

**Where:** `src/platform/db/schemas/articles.ts`, `tsvector`, `articles.searchVector`

Extends ADR 0006. drizzle has no tsvector builder, so the column uses a custom type whose TypeScript type is only a placeholder: nothing reads the column in TypeScript, it exists for the GIN index and the `@@` match. The generated expression uses unqualified column names because a generated expression may read only its own row, and the table is still being defined at that point.

### enclosures bypasses drizzle's jsonb serialisation

**Where:** `src/platform/db/schemas/articles.ts`, `enclosuresJsonb`

Bun SQL encodes a bound object as JSON itself. drizzle's `jsonb()` stringifies the value first, which PostgreSQL then stores as one JSON string instead of an array, so the custom type passes the value through untouched.

### user_articles is keyed on (source, guid) with no foreign key to articles

**Where:** `src/platform/db/schemas/user-articles.ts`, `userArticles`

A per-user removal is keyed on the article's natural identity, `(user, source, guid)`, not on `articles.id`. A cascade from articles would forget a removal as soon as pruning misjudged a feed window once: the next fetch listing that guid would bring it back unread under a fresh id. Keyed this way the removal outlives the article row, and every read is "this user's state for these articles", so the primary key serves all of them. A removal for a guid the feed never lists again is kept until its source or user goes (about 66 bytes a row, thousands a year); add a sweep if that ever grows large.

## Sources

### sources.kind is the explicit delivery mechanism, last_fetch_trigger the observed one

**Where:** `src/platform/db/schemas/sources.ts`, `sources.kind`, `sources.lastFetchTrigger`

`kind` is stored rather than inferred from the URL and drives the polling cadence in `getSourcesToProcess`. Sources move from feed to websub on `markWebSubVerified` and back on `markWebSubFailed`; "email" is set at creation and never changes. A websub source shows "poll" in `last_fetch_trigger` on its fallback fetches, so that column, not `kind`, confirms that push delivery is actually happening.

### sources.not_before is written on both outcomes and defaults to the epoch

**Where:** `src/platform/db/schemas/sources.ts`, `sources.notBefore`

`successSource` writes it from Cache-Control and `failSource` from the backoff formula, so the scheduler's read side is just `not_before <= NOW()`. It defaults to the Unix epoch rather than NULL so no query needs an `IS NULL OR`.

### reserved_by owns a newsletter address and is SET NULL on user delete

**Where:** `src/platform/db/schemas/sources.ts`, `sources.reservedBy`, `sources_reserved_by_idx`; `drizzle/0013_unusual_ulik.sql`; `src/__tests__/migration-integration.test.ts`

`reserved_by` is the account a newsletter address belongs to, set when the source is created by reserving or subscribing to it, so no other account can subscribe and read its mail (#1116); it is NULL for feeds. Before 0013 any account could subscribe to any address, so the migration made each older email source's earliest subscriber the owner, ties broken by subscription id. The orphan cleanup keeps an owned source that has had mail, so the address is not free to take while its owner exists. The foreign key is SET NULL, not CASCADE, because an older email source can have other subscribers whose subscription and mail a cascade would delete; unowned and unsubscribed, the source then goes in the orphan cleanup. The index is partial because only email sources are owned, and the user cascade looks sources up by owner.

### WebSub columns keep the hub's exact topic and guard against double subscribes

**Where:** `src/platform/db/schemas/sources.ts`, `websubTopicUrl`, `websubSubscribeAttemptedAt`

`websub_topic_url` is the canonical URL from the hub advertisement, which can differ from `url`; the hub requires the exact topic it was told about. `websub_subscribe_attempted_at` is a claim guard: discovery fires at subscribe time and again from the initial-fetch job, each minting its own token and secret, and a strict hub rejects the second request outright. `recordWebSubDiscovery` claims it with a conditional UPDATE.

### user_sources has no separate (user_id, source_id) index

**Where:** `drizzle/0007_salty_salo.sql`

The UNIQUE(user_id, source_id) constraint's own index covers the same ordered columns, so the nonunique `user_sources_user_source_idx` was redundant and is dropped.

## Sessions and users

### Session indexes are built in the migration transaction

**Where:** `src/platform/db/schemas/sessions.ts`, `sessions_sid_unique`, `sessions_user_id_idx`; `drizzle/0008_optimal_vanisher.sql`

Every authenticated request resolves its cookie through `sid`, and the session list and both revocation paths filter by `user_id`. Both indexes are built in-transaction rather than pre-built `CONCURRENTLY`: the table holds one row per login, so the lock is brief. `sid` is a random UUID per login, so a duplicate should never exist; if one does, it fails the whole migration instead of leaving the `user_id` index applied beside an invalid unique index.

### Sessions record last use separately from creation

**Where:** `src/platform/db/schemas/sessions.ts`, `sessions.lastUsedAt`

Extends ADR 0005. `last_used_at` is the last request a sid answered, refreshed by the auth plugin with a self-guarded write. It is separate from `created_at` because the migration that introduced `created_at` backfilled every existing row with one shared timestamp, so sign-in dates for old sessions are unrecoverable and activity is the honest per-row clock.

### Password reset tokens are stored as SHA-256 digests

**Where:** `src/platform/db/schemas/users.ts`, `users.passwordResetTokenHash`

Unlike the activation token beside it, a reset token alone is enough to take an account over, so a dump of the table must not be a set of working reset links. The token is 122 random bits, past brute force without key stretching, so a plain SHA-256 digest is enough.

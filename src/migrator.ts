import type { ReservedSQL } from "bun";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { AppConfig } from "#platform/config.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";

type PendingIndex = { create: string; name: string; table: string };

const migrationJournal = Type.Object({
  entries: Type.Array(Type.Object({ tag: Type.String(), when: Type.Number() })),
});

// A plain `CREATE INDEX` runs inside the migration's transaction: instant on
// an empty table, an ACCESS EXCLUSIVE lock for the whole build on a populated
// one. Hand-editing the generated statement to `CREATE INDEX IF NOT EXISTS`
// opts in here: this pass builds the index CONCURRENTLY first, so the
// in-transaction statement finds it already there.
//
// The statements are read back out of the migration files, so an index is
// written down once and a new migration opts in by how it is written, not by
// also being registered here.
const concurrentIndexPattern =
  /CREATE INDEX IF NOT EXISTS "(?<name>[^"]+)" ON "(?<table>[^"]+)"[^;]*/giu;

async function journaledTimestamps(client: ReservedSQL) {
  const [journal] = await client<
    { migrationJournalExists: boolean }[]
  >`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
      AS "migrationJournalExists"`;
  if (!journal?.migrationJournalExists) return new Set<number>();

  const applied = await client<
    { createdAt: string }[]
  >`SELECT "created_at"::text AS "createdAt" FROM "drizzle"."__drizzle_migrations"`;
  return new Set(applied.map((row) => Number(row.createdAt)));
}

// Split from the database work so it can be checked against the real
// migration files without one: a pattern that matched nothing still leaves
// every index valid, just built the blocking way, which no assertion about the
// resulting schema can detect.
export function parseConcurrentIndexes(statements: string): PendingIndex[] {
  const parsed: PendingIndex[] = [];
  for (const match of statements.matchAll(concurrentIndexPattern)) {
    const { name, table } = match.groups ?? {};
    if (!name || !table) continue;
    parsed.push({
      create: match[0].replace(/^CREATE INDEX/iu, "CREATE INDEX CONCURRENTLY"),
      name,
      table,
    });
  }
  return parsed;
}

async function pendingConcurrentIndexes(
  client: ReservedSQL,
  migrationsFolder: string,
) {
  const journal = Value.Decode(
    migrationJournal,
    await Bun.file(`${migrationsFolder}/meta/_journal.json`).json(),
  );
  const applied = await journaledTimestamps(client);
  const pending: PendingIndex[] = [];

  for (const entry of journal.entries) {
    if (applied.has(entry.when)) continue;
    // eslint-disable-next-line no-await-in-loop -- Migrations are ordered.
    const statements = await Bun.file(
      `${migrationsFolder}/${entry.tag}.sql`,
    ).text();
    pending.push(...parseConcurrentIndexes(statements));
  }
  return pending;
}

async function prebuildIndexesConcurrently(
  client: ReservedSQL,
  indexes: readonly PendingIndex[],
) {
  for (const index of indexes) {
    // On a fresh database the table's migration hasn't run yet, and an index
    // on a table about to be created empty costs nothing in-transaction.
    // eslint-disable-next-line no-await-in-loop -- Concurrent index maintenance must run sequentially on the reserved session.
    const [target] = await client<
      { tableExists: boolean }[]
    >`SELECT to_regclass(${`public.${index.table}`}) IS NOT NULL AS "tableExists"`;
    if (!target?.tableExists) continue;

    // eslint-disable-next-line no-await-in-loop -- Concurrent index maintenance must run sequentially on the reserved session.
    const [state] = await client<{ exists: boolean; valid: boolean }[]>`SELECT
        EXISTS (
          SELECT 1
          FROM pg_class AS index_class
          INNER JOIN pg_namespace AS namespace
            ON namespace.oid = index_class.relnamespace
          WHERE namespace.nspname = 'public'
            AND index_class.relname = ${index.name}
            AND index_class.relkind = 'i'
        ) AS "exists",
        EXISTS (
          SELECT 1
          FROM pg_class AS index_class
          INNER JOIN pg_namespace AS namespace
            ON namespace.oid = index_class.relnamespace
          INNER JOIN pg_index ON pg_index.indexrelid = index_class.oid
          WHERE namespace.nspname = 'public'
            AND index_class.relname = ${index.name}
            AND index_class.relkind = 'i'
            AND pg_index.indisvalid
        ) AS "valid"`;

    // A CREATE INDEX CONCURRENTLY that was interrupted leaves an invalid
    // index behind that IF NOT EXISTS would happily keep, so drop it first.
    if (state?.exists && !state.valid) {
      // eslint-disable-next-line no-await-in-loop -- PostgreSQL forbids concurrent index maintenance in a transaction.
      await client.unsafe(`DROP INDEX CONCURRENTLY "public"."${index.name}"`);
    }
    if (!state?.valid) {
      // eslint-disable-next-line no-await-in-loop -- PostgreSQL forbids concurrent index maintenance in a transaction.
      await client.unsafe(index.create);
    }
  }
}

// On a cold start the migrator routinely beats PostgreSQL to accepting
// connections. Retrying here keeps readiness out of the orchestrator's hands,
// which Swarm does not manage at all. Only the initial connection retries; a
// failure once migrating has started stays loud.
//
// ponytail: fixed one-second poll to a fixed deadline; add backoff if a
// slow-starting PostgreSQL ever makes the log noise a real complaint.
const connectRetryDeadline = 120_000;
const connectRetryInterval = 1_000;

async function reserveWhenReady(
  databaseUrl: AppConfig["DATABASE_URL"],
  deadline: number,
) {
  const giveUpAt = Date.now() + deadline;
  for (;;) {
    const database = createDrizzleConnection(databaseUrl);
    try {
      // eslint-disable-next-line no-await-in-loop -- Retries are sequential by nature.
      return { database, reserved: await database.$client.reserve() };
    } catch (cause) {
      // eslint-disable-next-line no-await-in-loop -- Retries are sequential by nature.
      await database.$client.close().catch(() => undefined);
      if (Date.now() >= giveUpAt) throw cause;
      console.log("Database is not accepting connections yet; retrying");
      // eslint-disable-next-line no-await-in-loop -- Retries are sequential by nature.
      await Bun.sleep(connectRetryInterval);
    }
  }
}

export async function migrateDatabase(
  databaseUrl: AppConfig["DATABASE_URL"],
  migrationsFolder = "./drizzle",
  deadline = connectRetryDeadline,
) {
  const { database, reserved } = await reserveWhenReady(databaseUrl, deadline);
  try {
    let locked = false;
    try {
      await reserved`SELECT pg_advisory_lock(hashtextextended('feedfathom:migrations', 0))`;
      locked = true;
      await prebuildIndexesConcurrently(
        reserved,
        await pendingConcurrentIndexes(reserved, migrationsFolder),
      );
      await migrate(createDrizzleConnection(databaseUrl, reserved), {
        migrationsFolder,
      });
      console.log("Migrations complete");
    } finally {
      try {
        // A migration failing mid-transaction can leave the session unable to
        // answer, and this throwing would replace the real error. The lock is
        // session-scoped, so closing the client releases it either way.
        if (locked)
          await reserved`SELECT pg_advisory_unlock(hashtextextended('feedfathom:migrations', 0))`.catch(
            () => undefined,
          );
      } finally {
        reserved.release();
      }
    }
  } finally {
    await database.$client.close().catch(() => undefined);
  }
}

if (import.meta.main) {
  const { config } = await import("#platform/config.ts");
  await migrateDatabase(config.DATABASE_URL);
}

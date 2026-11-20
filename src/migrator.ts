import type { ReservedSQL } from "bun";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { AppConfig } from "#platform/config.ts";
import {
  createDrizzleConnection,
  isNotReady,
} from "#platform/db/connection.ts";

type PendingIndex = { create: string; name: string; table: string };

const migrationJournal = Type.Object({
  entries: Type.Array(Type.Object({ tag: Type.String(), when: Type.Number() })),
});

const concurrentIndexPattern =
  /CREATE INDEX IF NOT EXISTS "(?<name>[^"]+)" ON "(?<table>[^"]+)"[^;]*/giu;

const concurrentDropPattern = /DROP INDEX IF EXISTS "(?<name>[^"]+)"/giu;

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

export function parseConcurrentDrops(statements: string): string[] {
  return [...statements.matchAll(concurrentDropPattern)].flatMap((match) => {
    const { name } = match.groups ?? {};
    return name ? [name] : [];
  });
}

async function pendingStatements(
  client: ReservedSQL,
  migrationsFolder: string,
) {
  const journal = Value.Decode(
    migrationJournal,
    await Bun.file(`${migrationsFolder}/meta/_journal.json`).json(),
  );
  const applied = await journaledTimestamps(client);
  const pending: string[] = [];

  for (const entry of journal.entries) {
    if (applied.has(entry.when)) continue;
    // eslint-disable-next-line no-await-in-loop -- Migrations are ordered.
    pending.push(await Bun.file(`${migrationsFolder}/${entry.tag}.sql`).text());
  }
  return pending.join("\n");
}

const dependsOnPendingMigration = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "errno" in error &&
  typeof error.errno === "string" &&
  error.errno.startsWith("42");

async function prebuildIndexesConcurrently(
  client: ReservedSQL,
  indexes: readonly PendingIndex[],
) {
  for (const index of indexes) {
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

    if (state?.exists && !state.valid) {
      // eslint-disable-next-line no-await-in-loop -- PostgreSQL forbids concurrent index maintenance in a transaction.
      await client.unsafe(`DROP INDEX CONCURRENTLY "public"."${index.name}"`);
    }
    if (!state?.valid) {
      // eslint-disable-next-line no-await-in-loop -- PostgreSQL forbids concurrent index maintenance in a transaction.
      await client.unsafe(index.create).catch(async (error: unknown) => {
        if (!dependsOnPendingMigration(error)) throw error;
        await client.unsafe(
          `DROP INDEX CONCURRENTLY IF EXISTS "public"."${index.name}"`,
        );
      });
    }
  }
}

async function predropIndexesConcurrently(
  client: ReservedSQL,
  names: readonly string[],
) {
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop -- PostgreSQL forbids concurrent index maintenance in a transaction.
    await client.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "public"."${name}"`);
  }
}

const connectRetryDeadline = 120_000;
const connectRetryInterval = 1_000;

type ConnectRetry = { deadline?: number; interval?: number };

async function reserveWhenReady(
  databaseUrl: AppConfig["DATABASE_URL"],
  {
    deadline = connectRetryDeadline,
    interval = connectRetryInterval,
  }: ConnectRetry,
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
      if (!isNotReady(cause) || Date.now() >= giveUpAt) throw cause;
      console.log("Database is not accepting connections yet; retrying");
      // eslint-disable-next-line no-await-in-loop -- Retries are sequential by nature.
      await Bun.sleep(interval);
    }
  }
}

const migrationLockKey = "feedfathom:migrations";

export async function migrateDatabase(
  databaseUrl: AppConfig["DATABASE_URL"],
  migrationsFolder = "./drizzle",
  connectRetry: ConnectRetry = {},
) {
  const { database, reserved } = await reserveWhenReady(
    databaseUrl,
    connectRetry,
  );
  try {
    let locked = false;
    try {
      await reserved`SELECT pg_advisory_lock(hashtextextended(${migrationLockKey}, 0))`;
      locked = true;
      const pending = await pendingStatements(reserved, migrationsFolder);
      await prebuildIndexesConcurrently(
        reserved,
        parseConcurrentIndexes(pending),
      );
      await predropIndexesConcurrently(reserved, parseConcurrentDrops(pending));
      await migrate(
        createDrizzleConnection(databaseUrl, { client: reserved }),
        {
          migrationsFolder,
        },
      );
      console.log("Migrations complete");
    } finally {
      try {
        if (locked)
          await reserved`SELECT pg_advisory_unlock(hashtextextended(${migrationLockKey}, 0))`.catch(
            () => undefined,
          );
      } finally {
        await reserved.release();
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

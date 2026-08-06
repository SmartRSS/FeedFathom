import type { ReservedSQL } from "bun";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { AppConfig } from "./config.ts";
import { createDrizzleConnection } from "./db/connection.ts";

type LegacyIndex = { create: string; name: string };

const migration0015Timestamp = 1_757_673_513_000;
const migration0015Indexes: readonly LegacyIndex[] = [
  {
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "articles_source_published_idx" ON "articles" USING btree ("source_id", "published_at")',
    name: "articles_source_published_idx",
  },
  {
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "articles_updated_at_idx" ON "articles" USING btree ("updated_at")',
    name: "articles_updated_at_idx",
  },
  {
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_articles_user_id_idx" ON "user_articles" USING btree ("user_id")',
    name: "user_articles_user_id_idx",
  },
  {
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_articles_article_id_idx" ON "user_articles" USING btree ("article_id")',
    name: "user_articles_article_id_idx",
  },
  {
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_articles_user_read_idx" ON "user_articles" USING btree ("user_id", "read_at")',
    name: "user_articles_user_read_idx",
  },
  {
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_sources_user_id_idx" ON "user_sources" USING btree ("user_id")',
    name: "user_sources_user_id_idx",
  },
  {
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_sources_source_id_idx" ON "user_sources" USING btree ("source_id")',
    name: "user_sources_source_id_idx",
  },
  {
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_sources_user_source_idx" ON "user_sources" USING btree ("user_id", "source_id")',
    name: "user_sources_user_source_idx",
  },
] as const;

// Migration 0017 added this index with a plain (blocking) CREATE INDEX --
// same problem 0015 had, so it gets the same concurrent-prebuild treatment.
// 0016 also adds an index (sources.next_check_at), but that migration
// already takes an ACCESS EXCLUSIVE lock across sources/articles/
// user_sources/user_source_settings/user_articles for a dedup pass, so its
// trailing CREATE INDEX adds no additional blocking and doesn't need this.
const migration0017Timestamp = 1_785_498_799_957;
const migration0017Indexes: readonly LegacyIndex[] = [
  {
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "articles_source_last_seen_idx" ON "articles" USING btree ("source_id", "last_seen_in_feed_at")',
    name: "articles_source_last_seen_idx",
  },
] as const;

// Migration 0021 replaces the single-column article_id index with a
// composite (article_id, user_id) index -- same populated-table concern as
// 0015/0017, so it gets the same concurrent-prebuild treatment.
const migration0021Timestamp = 1_786_019_269_655;
const migration0021Indexes: readonly LegacyIndex[] = [
  {
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_articles_article_user_idx" ON "user_articles" USING btree ("article_id", "user_id")',
    name: "user_articles_article_user_idx",
  },
] as const;

async function shouldPrebuildMigration0015Indexes(client: ReservedSQL) {
  const [tables] = await client<
    { targetTablesExist: boolean }[]
  >`SELECT to_regclass('public.articles') IS NOT NULL
      AND to_regclass('public.user_articles') IS NOT NULL
      AND to_regclass('public.user_sources') IS NOT NULL
      AS "targetTablesExist"`;
  if (!tables?.targetTablesExist) return false;

  const [contents] = await client<
    { targetTablesContainData: boolean }[]
  >`SELECT EXISTS (SELECT 1 FROM "articles")
      OR EXISTS (SELECT 1 FROM "user_articles")
      OR EXISTS (SELECT 1 FROM "user_sources")
      AS "targetTablesContainData"`;
  if (!contents?.targetTablesContainData) return false;

  const [journal] = await client<
    { migrationJournalExists: boolean }[]
  >`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
      AS "migrationJournalExists"`;
  if (!journal?.migrationJournalExists) return true;

  const [migration] = await client<
    { migration0015Journaled: boolean }[]
  >`SELECT EXISTS (
      SELECT 1
      FROM "drizzle"."__drizzle_migrations"
      WHERE "created_at" = ${migration0015Timestamp}
    ) AS "migration0015Journaled"`;
  return !migration?.migration0015Journaled;
}

async function shouldPrebuildMigration0017Indexes(client: ReservedSQL) {
  const [tables] = await client<
    { targetTableExists: boolean }[]
  >`SELECT to_regclass('public.articles') IS NOT NULL AS "targetTableExists"`;
  if (!tables?.targetTableExists) return false;

  const [contents] = await client<
    { targetTableContainsData: boolean }[]
  >`SELECT EXISTS (SELECT 1 FROM "articles") AS "targetTableContainsData"`;
  if (!contents?.targetTableContainsData) return false;

  const [journal] = await client<
    { migrationJournalExists: boolean }[]
  >`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
      AS "migrationJournalExists"`;
  if (!journal?.migrationJournalExists) return true;

  const [migration] = await client<
    { migration0017Journaled: boolean }[]
  >`SELECT EXISTS (
      SELECT 1
      FROM "drizzle"."__drizzle_migrations"
      WHERE "created_at" = ${migration0017Timestamp}
    ) AS "migration0017Journaled"`;
  return !migration?.migration0017Journaled;
}

async function shouldPrebuildMigration0021Indexes(client: ReservedSQL) {
  const [tables] = await client<
    { targetTableExists: boolean }[]
  >`SELECT to_regclass('public.user_articles') IS NOT NULL AS "targetTableExists"`;
  if (!tables?.targetTableExists) return false;

  const [contents] = await client<
    { targetTableContainsData: boolean }[]
  >`SELECT EXISTS (SELECT 1 FROM "user_articles") AS "targetTableContainsData"`;
  if (!contents?.targetTableContainsData) return false;

  const [journal] = await client<
    { migrationJournalExists: boolean }[]
  >`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
      AS "migrationJournalExists"`;
  if (!journal?.migrationJournalExists) return true;

  const [migration] = await client<
    { migration0021Journaled: boolean }[]
  >`SELECT EXISTS (
      SELECT 1
      FROM "drizzle"."__drizzle_migrations"
      WHERE "created_at" = ${migration0021Timestamp}
    ) AS "migration0021Journaled"`;
  return !migration?.migration0021Journaled;
}

async function prebuildIndexesConcurrently(
  client: ReservedSQL,
  indexes: readonly LegacyIndex[],
) {
  for (const index of indexes) {
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
      await client.unsafe(index.create);
    }
  }
}

async function prebuildLegacyIndexes(client: ReservedSQL) {
  if (await shouldPrebuildMigration0015Indexes(client))
    await prebuildIndexesConcurrently(client, migration0015Indexes);
  if (await shouldPrebuildMigration0017Indexes(client))
    await prebuildIndexesConcurrently(client, migration0017Indexes);
  if (await shouldPrebuildMigration0021Indexes(client))
    await prebuildIndexesConcurrently(client, migration0021Indexes);
}

export async function migrateDatabase(
  databaseUrl: AppConfig["DATABASE_URL"],
  migrationsFolder = "./drizzle",
) {
  const database = createDrizzleConnection(databaseUrl);
  try {
    const reserved = await database.$client.reserve();
    let locked = false;
    try {
      await reserved`SELECT pg_advisory_lock(hashtextextended('feedfathom:migrations', 0))`;
      locked = true;
      await prebuildLegacyIndexes(reserved);
      await migrate(createDrizzleConnection(databaseUrl, reserved), {
        migrationsFolder,
      });
      console.log("Migrations complete");
    } finally {
      try {
        if (locked)
          await reserved`SELECT pg_advisory_unlock(hashtextextended('feedfathom:migrations', 0))`;
      } finally {
        reserved.release();
      }
    }
  } finally {
    await database.$client.close();
  }
}

if (import.meta.main) {
  const { config } = await import("./config.ts");
  await migrateDatabase(config.DATABASE_URL);
}

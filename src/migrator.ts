import type { ReservedSQL } from "bun";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { AppConfig } from "./config.ts";
import { createDrizzleConnection } from "./db/connection.ts";

const migration0015Timestamp = 1_757_673_513_000;
const legacyIndexes = [
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

async function shouldPrebuildLegacyIndexes(client: ReservedSQL) {
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

async function prebuildLegacyIndexes(client: ReservedSQL) {
  if (!(await shouldPrebuildLegacyIndexes(client))) return;

  for (const index of legacyIndexes) {
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

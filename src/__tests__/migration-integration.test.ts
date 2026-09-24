import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForMigration } from "#platform/db/connection.ts";
import journal from "../../drizzle/meta/_journal.json";
import { migrateDatabase } from "../migrator.ts";
import { requireDisposableDatabaseUrl } from "#features/feeds/__tests__/disposable-database-url.ts";

const currentMigrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
const expectedIndexNames = [
  "articles_source_published_idx",
  "articles_updated_at_idx",
  "articles_source_last_seen_idx",
  "user_sources_user_id_idx",
  "user_sources_source_id_idx",
  "sessions_sid_unique",
  "sessions_user_id_idx",
].toSorted();
// The UNIQUE(user_id, source_id) constraint's own index covers the same
// ordered columns, so this nonunique copy was dropped by 0007.
const redundantIndexName = "user_sources_user_source_idx";

async function resetDatabase(client: SQL) {
  await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
  await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
  await client`CREATE SCHEMA "public"`;
}

async function expectIndexesValid(client: SQL) {
  const indexes = await client<
    { name: string; valid: boolean }[]
  >`SELECT index_class.relname AS "name", pg_index.indisvalid AS "valid"
    FROM pg_class AS index_class
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = index_class.relnamespace
    INNER JOIN pg_index ON pg_index.indexrelid = index_class.oid
    WHERE namespace.nspname = 'public'
      AND index_class.relname = ANY(${client.array(expectedIndexNames, "TEXT")})`;

  expect(indexes.map((index) => index.name).toSorted()).toEqual(
    expectedIndexNames,
  );
  expect(indexes.every((index) => index.valid)).toBe(true);
}

async function expectMigrationJournaledOnce(
  client: SQL,
  timestamp: number | undefined,
) {
  if (timestamp === undefined) {
    throw new Error("Expected migration is missing from the Drizzle journal");
  }
  const [entry] = await client<
    { count: number }[]
  >`SELECT count(*)::integer AS "count"
    FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" = ${timestamp}`;
  expect(entry?.count).toBe(1);
}

// The migration history was squashed to a single baseline, so there is no
// in-repo upgrade path from the pre-squash history -- the only database that has
// ever run the old 31 migrations is production, and it is stamped as having
// applied the baseline rather than running it. What remains testable is that
// the baseline builds the schema the application expects, and that running
// it twice is a no-op.
test("applies the baseline to an empty database, idempotently", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);

  try {
    await resetDatabase(client);
    await migrateDatabase(databaseUrl, currentMigrationsFolder);
    await migrateDatabase(databaseUrl, currentMigrationsFolder);

    for (const entry of journal.entries) {
      // eslint-disable-next-line no-await-in-loop -- Migrations are ordered.
      await expectMigrationJournaledOnce(client, entry.when);
    }
    await expectIndexesValid(client);

    const tables = await client<{ name: string }[]>`SELECT table_name AS "name"
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    expect(tables.map((table) => table.name).toSorted()).toEqual(
      [
        "articles",
        "job_failures",
        "opml_imports",
        "sessions",
        "sources",
        "user_articles",
        "user_folders",
        "user_source_settings",
        "user_sources",
        "users",
      ].toSorted(),
    );
  } finally {
    await client.close();
  }
});

test("gates startup on this build's newest migration, tolerating a newer database", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);

  try {
    await resetDatabase(client);

    const beforeMigrating = await Promise.race([
      waitForMigration(client, undefined, 10).then(() => "released"),
      Bun.sleep(250).then(() => "still waiting"),
    ]);
    expect(beforeMigrating).toBe("still waiting");

    await migrateDatabase(databaseUrl, currentMigrationsFolder);
    await expect(
      waitForMigration(client, undefined, 10),
    ).resolves.toBeUndefined();

    await client`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
      VALUES ('from-a-newer-build', ${9_999_999_999_999})`;
    await expect(
      waitForMigration(client, undefined, 10),
    ).resolves.toBeUndefined();
  } finally {
    await client.close();
  }
});

async function indexExists(client: SQL, name: string) {
  const [row] = await client<
    { exists: boolean }[]
  >`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS "exists"`;
  return row?.exists === true;
}

// A copy of the migrations folder whose journal stops before `tag`, standing
// in for an installation that predates that migration.
async function migrationsFolderBefore(tag: string) {
  const folder = await mkdtemp(join(tmpdir(), "feedfathom-migrations-"));
  await cp(currentMigrationsFolder, folder, { recursive: true });
  const cutoff = journal.entries.findIndex((entry) => entry.tag === tag);
  if (cutoff === -1) throw new Error(`Migration ${tag} is not journaled`);
  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, cutoff) }),
  );
  return folder;
}

test("upgrading drops the redundant user-sources index and keeps the unique constraint", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const olderMigrationsFolder = await migrationsFolderBefore("0007_salty_salo");

  try {
    await resetDatabase(client);
    await migrateDatabase(databaseUrl, olderMigrationsFolder);
    expect(await indexExists(client, redundantIndexName)).toBe(true);

    await migrateDatabase(databaseUrl, currentMigrationsFolder);
    expect(await indexExists(client, redundantIndexName)).toBe(false);
    await expectIndexesValid(client);

    const constraints = await client<
      { definition: string }[]
    >`SELECT pg_get_constraintdef(oid) AS "definition"
      FROM pg_constraint
      WHERE conname = 'user_sources_user_id_source_id_unique'`;
    expect(constraints.map((row) => row.definition)).toEqual([
      "UNIQUE (user_id, source_id)",
    ]);

    const [user] = await client<{ id: number }[]>`INSERT INTO "users"
      ("email", "name", "password")
      VALUES ('upgrade@example.com', 'upgrade', 'x') RETURNING "id"`;
    const [source] = await client<{ id: number }[]>`INSERT INTO "sources"
      ("url", "home_url") VALUES ('https://example.com/feed', 'https://example.com')
      RETURNING "id"`;
    await client`INSERT INTO "user_sources" ("name", "source_id", "user_id")
      VALUES ('feed', ${source?.id}, ${user?.id})`;
    const found = await client`SELECT "id" FROM "user_sources"
      WHERE "user_id" = ${user?.id} AND "source_id" = ${source?.id}`;
    expect(found).toHaveLength(1);
    // A Bun SQL query only runs once `then` is called, which `rejects` never
    // does on its own.
    await expect(
      client`INSERT INTO "user_sources" ("name", "source_id", "user_id")
        VALUES ('again', ${source?.id}, ${user?.id})`.then(() => "inserted"),
    ).rejects.toThrow(/user_sources_user_id_source_id_unique/u);
  } finally {
    await client.close();
    await rm(olderMigrationsFolder, { force: true, recursive: true });
  }
});

// sid is a random UUID per login, so duplicates should never exist. If one
// does, the unique index build must fail the whole migration transaction
// rather than leave the user_id index applied without it.
test("a duplicate sid fails the session index migration and applies none of it", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const olderMigrationsFolder = await migrationsFolderBefore(
    "0008_optimal_vanisher",
  );

  try {
    await resetDatabase(client);
    await migrateDatabase(databaseUrl, olderMigrationsFolder);
    const [user] = await client<{ id: number }[]>`INSERT INTO "users"
      ("email", "name", "password")
      VALUES ('duplicate@example.com', 'duplicate', 'x') RETURNING "id"`;
    await client`INSERT INTO "sessions" ("sid", "user_agent", "user_id")
      VALUES ('same', 'a', ${user?.id}), ('same', 'b', ${user?.id})`;

    await expect(
      migrateDatabase(databaseUrl, currentMigrationsFolder),
    ).rejects.toThrow(/sessions_sid_unique/u);
    expect(await indexExists(client, "sessions_sid_unique")).toBe(false);
    expect(await indexExists(client, "sessions_user_id_idx")).toBe(false);
    const [journaled] = await client<{ count: number }[]>`SELECT
      count(*)::integer AS "count" FROM "drizzle"."__drizzle_migrations"`;
    expect(journaled?.count).toBe(journal.entries.length - 1);
  } finally {
    await client.close();
    await rm(olderMigrationsFolder, { force: true, recursive: true });
  }
});

// The startup-gate test forges a journal row for a build newer than this one,
// so the last word has to be a real migration. CI points DATABASE_URL and
// MIGRATION_TEST_DATABASE_URL at the same ephemeral database, and leaving a
// forged journal behind breaks whatever runs next against it.
afterAll(async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  try {
    await resetDatabase(client);
    await migrateDatabase(databaseUrl, currentMigrationsFolder);
  } finally {
    await client.close();
  }
});

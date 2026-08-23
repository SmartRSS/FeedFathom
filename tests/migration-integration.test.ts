import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { waitForMigration } from "#platform/db/connection.ts";
import journal from "../drizzle/meta/_journal.json";
import { adoptSquashedBaseline, migrateDatabase } from "../src/migrator.ts";

const currentMigrationsFolder = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);
const expectedIndexNames = [
  "articles_source_published_idx",
  "articles_updated_at_idx",
  "articles_source_last_seen_idx",
  "user_articles_user_id_idx",
  "user_articles_article_user_idx",
  "user_articles_user_read_idx",
  "user_sources_user_id_idx",
  "user_sources_source_id_idx",
  "user_sources_user_source_idx",
].toSorted();

function requireDisposableDatabaseUrl() {
  const databaseUrl = process.env["MIGRATION_TEST_DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("MIGRATION_TEST_DATABASE_URL is required");
  }

  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !/(?:^|[_-])(?:disposable|migration_test|test)(?:[_-]|$)/i.test(
      databaseName,
    )
  ) {
    throw new Error(
      "MIGRATION_TEST_DATABASE_URL must target a clearly disposable PostgreSQL database whose name includes a test or disposable marker",
    );
  }

  return databaseUrl;
}

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
// longer an in-repo upgrade path to exercise -- the only database that has
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

// The squash shim. Reproducing it without the deleted migration files means
// building the schema from the baseline and then rewriting the journal to
// look like a database that predates the squash.
const preSquashFinalMigration = 1_786_570_692_742;

async function forgeJournal(client: SQL, appliedAt: number) {
  await client`DELETE FROM "drizzle"."__drizzle_migrations"`;
  await client`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
    VALUES ('pre-squash', ${appliedAt})`;
}

test("adopts the baseline for a database that reached the final pre-squash migration", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);

  try {
    await resetDatabase(client);
    await migrateDatabase(databaseUrl, currentMigrationsFolder);
    await forgeJournal(client, preSquashFinalMigration);

    await migrateDatabase(databaseUrl, currentMigrationsFolder);

    const [adopted] = await client<
      { count: number }[]
    >`SELECT count(*)::integer AS "count"
      FROM "drizzle"."__drizzle_migrations"
      WHERE "created_at" = ${journal.entries[0]?.when}`;
    expect(adopted?.count).toBe(1);
    await expectIndexesValid(client);
  } finally {
    await client.close();
  }
});

// The dangerous case: a database stopped somewhere in the middle of the old
// history has neither the baseline's schema nor a claim to it, so it must not
// be recorded as migrated.
//
// Asserted against the decision itself rather than by running a migration that
// fails. Drizzle's transaction teardown floats an unhandled rejection on that
// path, which neither .rejects.toThrow() nor an explicit try/catch can catch
// because it never reaches the awaited promise, and whether a Bun release
// fails the test on it has already changed once. That a partial database is
// rejected by CREATE TABLE is PostgreSQL's behaviour; the branch below is
// ours, and is what is actually in question.
test("refuses to adopt the baseline for a partially migrated database", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);

  try {
    await resetDatabase(client);
    await migrateDatabase(databaseUrl, currentMigrationsFolder);
    await forgeJournal(client, preSquashFinalMigration - 1);

    const reserved = await client.reserve();
    try {
      await adoptSquashedBaseline(reserved, currentMigrationsFolder);
    } finally {
      reserved.release();
    }

    const rows = await client<
      { createdAt: string }[]
    >`SELECT "created_at"::text AS "createdAt" FROM "drizzle"."__drizzle_migrations"`;
    expect(rows.map((row) => Number(row.createdAt))).toEqual([
      preSquashFinalMigration - 1,
    ]);
  } finally {
    await client.close();
  }
});

// These tests forge the journal to reproduce pre-squash databases, so the
// last word has to be a real migration. CI points DATABASE_URL and
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

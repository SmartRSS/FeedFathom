import { afterAll, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForMigration } from "#platform/db/connection.ts";
import journal from "../../drizzle/meta/_journal.json";
import { migrateDatabase } from "../migrator.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";

const currentMigrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
const expectedIndexNames = [
  "articles_source_published_covering_idx",
  "articles_source_last_seen_idx",
  "user_sources_user_id_idx",
  "user_sources_source_id_idx",
  "sessions_sid_unique",
  "sessions_user_id_idx",
].toSorted();
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

test("stops waiting on a database it cannot sign in to", async () => {
  const databaseUrl = new URL(requireDisposableDatabaseUrl());
  databaseUrl.password = "not-the-password";
  const client = new SQL(databaseUrl.href);
  try {
    await expect(waitForMigration(client, undefined, 10)).rejects.toThrow(
      SQL.PostgresError,
    );
  } finally {
    await client.close();
  }
});

test("the migrator stops retrying a database it cannot sign in to", async () => {
  const databaseUrl = new URL(requireDisposableDatabaseUrl());
  databaseUrl.password = "not-the-password";
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(
      migrateDatabase(databaseUrl.href, currentMigrationsFolder, {
        deadline: 60_000,
        interval: 10,
      }),
    ).rejects.toThrow(SQL.PostgresError);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

async function indexExists(client: SQL, name: string) {
  const [row] = await client<
    { valid: boolean }[]
  >`SELECT pg_index.indisvalid AS "valid"
    FROM pg_index
    WHERE pg_index.indexrelid = to_regclass(${`public.${name}`})`;
  if (row && !row.valid) throw new Error(`Index ${name} is INVALID`);
  return row !== undefined;
}

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
    expect(await indexExists(client, "articles_updated_at_idx")).toBe(true);

    await migrateDatabase(databaseUrl, currentMigrationsFolder);
    expect(await indexExists(client, redundantIndexName)).toBe(false);
    expect(await indexExists(client, "articles_updated_at_idx")).toBe(false);
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
    await expect(
      client`INSERT INTO "user_sources" ("name", "source_id", "user_id")
        VALUES ('again', ${source?.id}, ${user?.id})`.then(() => "inserted"),
    ).rejects.toThrow(/user_sources_user_id_source_id_unique/u);
  } finally {
    await client.close();
    await rm(olderMigrationsFolder, { force: true, recursive: true });
  }
});

test("upgrading a populated baseline database keeps every row and its state", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const baselineFolder = await migrationsFolderBefore("0001_optimal_barracuda");

  try {
    await resetDatabase(client);
    await migrateDatabase(databaseUrl, baselineFolder);
    const [user] = await client<{ id: number }[]>`INSERT INTO "users"
      ("email", "name", "password", "status")
      VALUES ('kept@example.com', 'kept', 'x', 'active') RETURNING "id"`;
    const [source] = await client<{ id: number }[]>`INSERT INTO "sources"
      ("url", "home_url") VALUES ('https://example.com/feed', 'https://example.com')
      RETURNING "id"`;
    const [folder] = await client<{ id: number }[]>`INSERT INTO "user_folders"
      ("name", "user_id") VALUES ('News', ${user?.id}) RETURNING "id"`;
    await client`INSERT INTO "user_sources" ("name", "parent_id", "source_id", "user_id")
      VALUES ('Feed', ${folder?.id}, ${source?.id}, ${user?.id})`;
    const articles = await client<{ id: number }[]>`INSERT INTO "articles"
      ("author", "content", "guid", "published_at", "source_id", "title", "url")
      VALUES
        ('a', 'zeppelin body', 'read-guid', NOW(), ${source?.id}, 'Read', 'https://example.com/1'),
        ('a', 'body', 'removed-guid', NOW(), ${source?.id}, 'Removed', 'https://example.com/2')
      RETURNING "id"`;
    await client`INSERT INTO "user_articles" ("article_id", "read_at", "deleted_at", "user_id")
      VALUES
        (${articles[0]?.id}, NOW(), NULL, ${user?.id}),
        (${articles[1]?.id}, NULL, NOW(), ${user?.id})`;
    await client`INSERT INTO "sessions" ("sid", "user_agent", "user_id")
      VALUES ('kept-sid', 'Browser', ${user?.id})`;

    await migrateDatabase(databaseUrl, currentMigrationsFolder);

    const userArticles = await client<
      { deleted: boolean; guid: string; read: boolean; sourceId: number }[]
    >`SELECT "guid", "source_id" AS "sourceId",
        "read_at" IS NOT NULL AS "read", "deleted_at" IS NOT NULL AS "deleted"
      FROM "user_articles" ORDER BY "guid"`;
    expect([...userArticles]).toEqual([
      { deleted: false, guid: "read-guid", read: true, sourceId: source!.id },
      {
        deleted: true,
        guid: "removed-guid",
        read: false,
        sourceId: source!.id,
      },
    ]);
    const [counts] = await client<
      { articles: number; folders: number; sessions: number; subs: number }[]
    >`SELECT
        (SELECT count(*)::int FROM "articles") AS "articles",
        (SELECT count(*)::int FROM "user_folders") AS "folders",
        (SELECT count(*)::int FROM "user_sources" WHERE "parent_id" = ${folder?.id}) AS "subs",
        (SELECT count(*)::int FROM "sessions"
          WHERE "sid" = 'kept-sid' AND "expires_at" > NOW()) AS "sessions"`;
    expect(counts).toEqual({ articles: 2, folders: 1, sessions: 1, subs: 1 });
    const searchable = await client<{ guid: string; enclosures: unknown }[]>`
      SELECT "guid", "enclosures" FROM "articles"
      WHERE "search_vector" @@ to_tsquery('english', 'zeppelin')`;
    expect([...searchable]).toEqual([{ enclosures: [], guid: "read-guid" }]);
  } finally {
    await client.close();
    await rm(baselineFolder, { force: true, recursive: true });
  }
});

test("upgrading gives each email source its earliest subscriber as owner", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const olderMigrationsFolder =
    await migrationsFolderBefore("0013_unusual_ulik");

  try {
    await resetDatabase(client);
    await migrateDatabase(databaseUrl, olderMigrationsFolder);
    const users = await client<{ id: number }[]>`INSERT INTO "users"
      ("email", "name", "password")
      VALUES ('a@example.com', 'a', 'x'), ('b@example.com', 'b', 'x'), ('c@example.com', 'c', 'x')
      RETURNING "id"`;
    const [a, b, c] = users.map(({ id }) => id);
    const sources = await client<
      { id: number; url: string }[]
    >`INSERT INTO "sources"
      ("url", "home_url", "kind")
      VALUES
        ('shared@mail.example', 'http://localhost', 'email'),
        ('tied@mail.example', 'http://localhost', 'email'),
        ('orphan@mail.example', 'http://localhost', 'email'),
        ('https://example.com/feed', 'https://example.com', 'feed')
      RETURNING "id", "url"`;
    const [shared, tied, , feed] = sources.map(({ id }) => id);
    await client`INSERT INTO "user_sources" ("name", "source_id", "user_id", "created_at")
      VALUES
        ('x', ${shared}, ${a}, '2026-02-01'),
        ('x', ${shared}, ${b}, '2026-01-01'),
        ('x', ${feed}, ${a}, '2026-01-01')`;
    await client`INSERT INTO "user_sources" ("id", "name", "source_id", "user_id", "created_at")
      VALUES
        (20, 'x', ${tied}, ${a}, '2026-01-01'),
        (10, 'x', ${tied}, ${c}, '2026-01-01')`;

    await migrateDatabase(databaseUrl, currentMigrationsFolder);

    const owners = await client<{ owner: null | number; url: string }[]>`
      SELECT "url", "reserved_by" AS "owner" FROM "sources" ORDER BY "id"`;
    expect([...owners]).toEqual([
      { owner: b!, url: "shared@mail.example" },
      { owner: c!, url: "tied@mail.example" },
      { owner: null, url: "orphan@mail.example" },
      { owner: null, url: "https://example.com/feed" },
    ]);
    const [{ count } = { count: -1 }] = await client<{ count: number }[]>`
      SELECT count(*)::int AS "count" FROM "user_sources"`;
    expect(count).toBe(5);
    expect(await indexExists(client, "sources_reserved_by_idx")).toBe(true);
    const [{ onDelete } = { onDelete: "" }] = await client<
      { onDelete: string }[]
    >`SELECT confdeltype AS "onDelete" FROM pg_constraint
      WHERE conname = 'sources_reserved_by_users_id_fk'`;
    expect(onDelete).toBe("n");
  } finally {
    await client.close();
    await rm(olderMigrationsFolder, { force: true, recursive: true });
  }
});

test("upgrading decodes stored feed names and strips markup from authors", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const olderMigrationsFolder = await migrationsFolderBefore(
    "0014_plain_feed_names",
  );

  try {
    await resetDatabase(client);
    await migrateDatabase(databaseUrl, olderMigrationsFolder);
    const [user] = await client<{ id: number }[]>`INSERT INTO "users"
      ("email", "name", "password") VALUES ('a@example.com', 'a', 'x')
      RETURNING "id"`;
    const [source] = await client<{ id: number }[]>`INSERT INTO "sources"
      ("url", "home_url") VALUES ('https://example.com/feed', 'https://example.com')
      RETURNING "id"`;
    await client`INSERT INTO "user_folders" ("name", "user_id")
      VALUES ('Tom &amp; Jerry', ${user!.id})`;
    await client`INSERT INTO "user_sources" ("name", "source_id", "user_id")
      VALUES (${"Jake&#39;s &#x2014; &lt;dialog&gt; &#38;#39; &#0; &amp;amp; Bob & Al"}, ${source!.id}, ${user!.id})`;
    await client`INSERT INTO "articles"
      ("author", "content", "guid", "published_at", "source_id", "title", "url")
      VALUES
        (${"span class='p-author h-card'>Geoff Graham</span"}, '', 'a', now(), ${source!.id}, 't', ''),
        (${"<a href='https://x.example'>Ann</a>"}, '', 'b', now(), ${source!.id}, 't', ''),
        (${"Jane <jane@example.com>"}, '', 'c', now(), ${source!.id}, 't', ''),
        (${"<span></span>"}, '', 'd', now(), ${source!.id}, 't', '')`;

    await migrateDatabase(databaseUrl, currentMigrationsFolder);

    const [folder] = await client<{ name: string }[]>`
      SELECT "name" FROM "user_folders"`;
    expect(folder?.name).toBe("Tom & Jerry");
    const [subscription] = await client<{ name: string }[]>`
      SELECT "name" FROM "user_sources"`;
    expect(subscription?.name).toBe(
      "Jake's \u2014 <dialog> &#39; \uFFFD &amp; Bob & Al",
    );
    const authors = await client<{ author: string }[]>`
      SELECT "author" FROM "articles" ORDER BY "guid"`;
    expect(authors.map(({ author }) => author)).toEqual([
      "Geoff Graham",
      "Ann",
      "Jane <jane@example.com>",
      "<span></span>",
    ]);
  } finally {
    await client.close();
    await rm(olderMigrationsFolder, { force: true, recursive: true });
  }
});

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
    expect(journaled?.count).toBe(
      journal.entries.findIndex(
        (entry) => entry.tag === "0008_optimal_vanisher",
      ),
    );
  } finally {
    await client.close();
    await rm(olderMigrationsFolder, { force: true, recursive: true });
  }
});

async function scratchMigrations(statements: readonly string[]) {
  const folder = await mkdtemp(join(tmpdir(), "feedfathom-migrations-"));
  const entries = statements.map((_, idx) => ({
    breakpoints: true,
    idx,
    tag: `${String(idx).padStart(4, "0")}_scratch`,
    version: "7",
    when: 1_000 + idx,
  }));
  await Promise.all(
    entries.map(async (entry, idx) =>
      writeFile(join(folder, `${entry.tag}.sql`), statements[idx] ?? ""),
    ),
  );
  const migrateTo = async (databaseUrl: string, count: number) => {
    await mkdir(join(folder, "meta"), { recursive: true });
    await writeFile(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({
        dialect: "postgresql",
        entries: entries.slice(0, count),
        version: "7",
      }),
    );
    await migrateDatabase(databaseUrl, folder);
  };
  return { folder, migrateTo };
}

const scratchBaseline = `CREATE TABLE "widgets" ("id" integer, "old" integer, "label" text);--> statement-breakpoint
CREATE TABLE "widget_settings" ("id" integer);--> statement-breakpoint
CREATE FUNCTION "widget_y"("n" integer) RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RETURN (SELECT "y" FROM "public"."widget_settings" LIMIT 1); END $$;`;

test.each([
  [
    "a column a pending migration adds",
    'ALTER TABLE "widgets" ADD COLUMN "x" integer;--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS "widgets_x_idx" ON "widgets" USING btree ("x");',
    "widgets_x_idx",
  ],
  [
    "a column a pending migration renames",
    'ALTER TABLE "widgets" RENAME COLUMN "old" TO "x";--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS "widgets_x_idx" ON "widgets" USING btree ("x");',
    "widgets_x_idx",
  ],
  [
    "a table a pending migration creates",
    'CREATE TABLE "gadgets" ("x" integer);--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS "gadgets_x_idx" ON "gadgets" USING btree ("x");',
    "gadgets_x_idx",
  ],
  [
    "an operator class a pending migration's extension provides",
    'CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS "widgets_label_trgm_idx" ON "widgets" USING gin ("label" gin_trgm_ops);',
    "widgets_label_trgm_idx",
  ],
  [
    "a function a pending migration creates",
    'CREATE FUNCTION "widget_key"("n" integer) RETURNS integer LANGUAGE sql IMMUTABLE AS \'SELECT n * 2\';--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS "widgets_key_idx" ON "widgets" USING btree (widget_key("id"));',
    "widgets_key_idx",
  ],
  [
    "a column only the build finds missing",
    'ALTER TABLE "widget_settings" ADD COLUMN "y" integer;--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS "widgets_y_idx" ON "widgets" USING btree (widget_y("id"));',
    "widgets_y_idx",
  ],
])("an index on %s is built by its migration", async (_, pending, name) => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const { folder, migrateTo } = await scratchMigrations([
    scratchBaseline,
    pending,
  ]);

  try {
    await resetDatabase(client);
    await migrateTo(databaseUrl, 1);
    await client`INSERT INTO "widgets" ("id", "old") VALUES (1, 1)`;

    await migrateTo(databaseUrl, 2);
    expect(await indexExists(client, name)).toBe(true);
  } finally {
    await client.close();
    await rm(folder, { force: true, recursive: true });
  }
});

test("a failed prebuild stops the deploy and the next run rebuilds its index", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const { folder, migrateTo } = await scratchMigrations([
    `${scratchBaseline}--> statement-breakpoint\nCREATE FUNCTION "widget_inverse"("n" integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 1 / n';`,
    'CREATE INDEX IF NOT EXISTS "widgets_inverse_idx" ON "widgets" USING btree (widget_inverse("id"));',
  ]);

  try {
    await resetDatabase(client);
    await migrateTo(databaseUrl, 1);
    await client`INSERT INTO "widgets" ("id") VALUES (0)`;

    await expect(migrateTo(databaseUrl, 2)).rejects.toMatchObject({
      errno: "22012",
    });
    await expect(indexExists(client, "widgets_inverse_idx")).rejects.toThrow(
      "INVALID",
    );

    await client`UPDATE "widgets" SET "id" = 1`;
    await migrateTo(databaseUrl, 2);
    expect(await indexExists(client, "widgets_inverse_idx")).toBe(true);
  } finally {
    await client.close();
    await rm(folder, { force: true, recursive: true });
  }
});

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

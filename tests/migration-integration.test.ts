import { expect, test } from "bun:test";
import { SQL } from "bun";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import journal from "../drizzle/meta/_journal.json";
import { ArticlesDataService } from "../src/db/data-services/article-data-service.ts";
import { createDrizzleConnection } from "../src/db/connection.ts";
import { migrateDatabase } from "../src/migrator.ts";

const migration0015Timestamp = 1_757_673_513_000;
const migration0016Timestamp = journal.entries.at(-1)?.when;
const currentMigrationsFolder = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);
const expectedIndexNames = [
  "articles_source_published_idx",
  "articles_updated_at_idx",
  "user_articles_user_id_idx",
  "user_articles_article_id_idx",
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

async function createLegacyMigrationsFolder() {
  const folder = await mkdtemp(join(tmpdir(), "feedfathom-migrations-0014-"));
  await mkdir(join(folder, "meta"));
  const entries = journal.entries.filter((entry) => entry.idx <= 14);
  await Promise.all(
    entries.map((entry) =>
      copyFile(
        join(currentMigrationsFolder, `${entry.tag}.sql`),
        join(folder, `${entry.tag}.sql`),
      ),
    ),
  );
  await writeFile(
    join(folder, "meta", "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
  );
  return folder;
}

async function seedLegacyData(client: SQL) {
  const [legacyUser] = await client<{ id: number }[]>`INSERT INTO "users" (
      "name", "email", "password", "status", "activation_token"
    ) VALUES (
      'Legacy User', 'legacy@example.test', 'hash', 'inactive', NULL
    ) RETURNING "id"`;
  const [tokenUser] = await client<{ id: number }[]>`INSERT INTO "users" (
      "name", "email", "password", "status", "activation_token"
    ) VALUES (
      'Token User', 'token@example.test', 'hash', 'inactive', 'pending-token'
    ) RETURNING "id"`;
  const [firstSource] = await client<
    { id: number }[]
  >`INSERT INTO "sources" ("url", "home_url")
    VALUES ('https://one.example.test/feed', 'https://one.example.test')
    RETURNING "id"`;
  const [secondSource] = await client<
    { id: number }[]
  >`INSERT INTO "sources" ("url", "home_url")
    VALUES ('https://two.example.test/feed', 'https://two.example.test')
    RETURNING "id"`;
  if (!legacyUser || !tokenUser || !firstSource || !secondSource) {
    throw new Error("Legacy seed inserts did not return their identifiers");
  }

  const [article] = await client<{ id: number }[]>`INSERT INTO "articles" (
      "source_id", "guid", "title", "url", "content", "author", "published_at"
    ) VALUES (
      ${firstSource.id}, 'shared-guid', 'Legacy article',
      'https://one.example.test/article', 'Legacy content', 'Author', now()
    ) RETURNING "id"`;
  if (!legacyUser || !tokenUser || !firstSource || !secondSource || !article) {
    throw new Error("Legacy seed inserts did not return their identifiers");
  }

  await client`INSERT INTO "user_sources" ("user_id", "source_id", "name")
    VALUES (${legacyUser.id}, ${firstSource.id}, 'Subscribed source')`;
  await client`INSERT INTO "user_articles" ("user_id", "article_id", "read_at")
    VALUES (${legacyUser.id}, ${article.id}, now())`;
  await client`INSERT INTO "job_queue" ("general_id", "name", "payload")
    VALUES (
      'legacy-job',
      'parse-source',
      jsonb_build_object('marker', 'preserve-me')
    )`;

  return {
    articleId: article.id,
    firstSourceId: firstSource.id,
    legacyUserId: legacyUser.id,
    secondSourceId: secondSource.id,
    tokenUserId: tokenUser.id,
  };
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

test("migrates legacy and fresh databases without deleting unmanaged queue data", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const legacyMigrationsFolder = await createLegacyMigrationsFolder();

  try {
    await resetDatabase(client);
    await migrateDatabase(databaseUrl, legacyMigrationsFolder);
    const seeded = await seedLegacyData(client);

    await migrateDatabase(databaseUrl, currentMigrationsFolder);
    await migrateDatabase(databaseUrl, currentMigrationsFolder);

    const users = await client<
      { activationToken: string | null; email: string; status: string }[]
    >`SELECT
        "activation_token" AS "activationToken", "email", "status"
      FROM "users"
      ORDER BY "email"`;
    expect(users).toEqual([
      {
        activationToken: null,
        email: "legacy@example.test",
        status: "active",
      },
      {
        activationToken: "pending-token",
        email: "token@example.test",
        status: "inactive",
      },
    ]);

    const [relationship] = await client<
      { articleId: number; sourceId: number; userId: number }[]
    >`SELECT
        user_articles.article_id AS "articleId",
        articles.source_id AS "sourceId",
        user_articles.user_id AS "userId"
      FROM "user_articles"
      INNER JOIN "articles" ON articles.id = user_articles.article_id
      INNER JOIN "user_sources"
        ON user_sources.user_id = user_articles.user_id
        AND user_sources.source_id = articles.source_id`;
    expect(relationship).toEqual({
      articleId: seeded.articleId,
      sourceId: seeded.firstSourceId,
      userId: seeded.legacyUserId,
    });

    const foreignKeys = await client<
      { name: string; valid: boolean }[]
    >`SELECT conname AS "name", convalidated AS "valid"
      FROM pg_constraint
      WHERE contype = 'f'
        AND conname = ANY(${client.array(
          [
            "articles_source_id_sources_id_fk",
            "user_articles_article_id_articles_id_fk",
            "user_articles_user_id_users_id_fk",
            "user_sources_source_id_sources_id_fk",
            "user_sources_user_id_users_id_fk",
          ],
          "TEXT",
        )})`;
    expect(foreignKeys).toHaveLength(5);
    expect(foreignKeys.every((foreignKey) => foreignKey.valid)).toBe(true);

    const constraints = await client<
      { definition: string; name: string }[]
    >`SELECT conname AS "name", pg_get_constraintdef(oid) AS "definition"
      FROM pg_constraint
      WHERE conrelid = 'public.articles'::regclass
        AND contype = 'u'`;
    expect(constraints).toEqual([
      {
        definition: "UNIQUE (source_id, guid)",
        name: "articles_source_id_guid_unique",
      },
    ]);

    await client`INSERT INTO "articles" (
      "source_id", "guid", "title", "url", "content", "author", "published_at"
    ) VALUES (
      ${seeded.secondSourceId}, 'shared-guid', 'Second source article',
      'https://two.example.test/article', 'Second content', 'Author', now()
    )`;

    const drizzleConnection = createDrizzleConnection(databaseUrl);
    try {
      const articlesDataService = new ArticlesDataService(drizzleConnection);
      await articlesDataService.batchUpsertArticles([
        {
          author: "Updated author",
          content: "Updated first content",
          guid: "shared-guid",
          publishedAt: new Date(),
          sourceId: seeded.firstSourceId,
          title: "Updated first article",
          updatedAt: new Date(),
          url: "https://one.example.test/article",
        },
        {
          author: "Updated author",
          content: "Updated second content",
          guid: "shared-guid",
          publishedAt: new Date(),
          sourceId: seeded.secondSourceId,
          title: "Updated second article",
          updatedAt: new Date(),
          url: "https://two.example.test/article",
        },
      ]);
    } finally {
      await drizzleConnection.$client.close();
    }

    const articles = await client<
      { guid: string; sourceId: number; title: string }[]
    >`SELECT "guid", "source_id" AS "sourceId", "title"
      FROM "articles"
      WHERE "guid" = 'shared-guid'
      ORDER BY "source_id"`;
    expect(articles).toEqual([
      {
        guid: "shared-guid",
        sourceId: seeded.firstSourceId,
        title: "Updated first article",
      },
      {
        guid: "shared-guid",
        sourceId: seeded.secondSourceId,
        title: "Updated second article",
      },
    ]);

    await expectIndexesValid(client);
    await expectMigrationJournaledOnce(client, migration0015Timestamp);
    await expectMigrationJournaledOnce(client, migration0016Timestamp);
    const [queueTable] = await client<
      { exists: boolean }[]
    >`SELECT to_regclass('public.job_queue') IS NOT NULL AS "exists"`;
    expect(queueTable?.exists).toBe(true);
    const queueRows = await client<
      { generalId: string; marker: string; name: string }[]
    >`SELECT
        "general_id" AS "generalId",
        "name",
        "payload" ->> 'marker' AS "marker"
      FROM "job_queue"`;
    expect(queueRows).toEqual([
      {
        generalId: "legacy-job",
        marker: "preserve-me",
        name: "parse-source",
      },
    ]);

    await resetDatabase(client);
    await migrateDatabase(databaseUrl, currentMigrationsFolder);
    await migrateDatabase(databaseUrl, currentMigrationsFolder);
    await expectIndexesValid(client);
    await expectMigrationJournaledOnce(client, migration0015Timestamp);
    await expectMigrationJournaledOnce(client, migration0016Timestamp);
    const [articleCount] = await client<
      { count: number }[]
    >`SELECT count(*)::integer AS "count" FROM "articles"`;
    expect(articleCount?.count).toBe(0);
  } finally {
    await rm(legacyMigrationsFolder, { force: true, recursive: true });
    await client.close();
  }
});

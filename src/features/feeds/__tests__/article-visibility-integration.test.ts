import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { articlePageSize } from "#shared/contracts/limits.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

test("a removal survives its article row being pruned and re-listed", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const articlesDataService = new ArticlesDataService(drizzleConnection);

  const addArticle = async (sourceId: number, guid: string) => {
    const [article] = await client<{ id: string }[]>`
      INSERT INTO articles (source_id, guid, author, title, url, content, published_at, updated_at, last_seen_in_feed_at)
      VALUES (${sourceId}, ${guid}, 'a', 't', '', 'body', NOW(), NOW(), NOW())
      RETURNING id`;
    return Number(article!.id);
  };
  const listedIds = async (sourceId: number, userId: number) =>
    (await articlesDataService.getUserArticlesForSources([sourceId], userId))
      .map((article) => article.id)
      .toSorted((left, right) => left - right);

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [user] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('reader@example.test', 'reader', 'x') RETURNING id`;
    const [source] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url, kind, last_success, not_before)
      VALUES ('https://feed.test/feed', 'https://feed.test', 'feed', NOW(), NOW())
      RETURNING id`;
    await client`
      INSERT INTO user_sources (user_id, source_id, name, created_at)
      VALUES (${user!.id}, ${source!.id}, 'sub', NOW() - INTERVAL '60 days')`;

    const kept = await addArticle(source!.id, "kept");
    const removed = await addArticle(source!.id, "removed");
    await addArticle(source!.id, "removed-edited");

    await client`
      INSERT INTO user_articles (user_id, source_id, guid, deleted_at)
      VALUES (${user!.id}, ${source!.id}, 'removed', NOW())`;
    await client`
      INSERT INTO user_articles (user_id, source_id, guid, deleted_at, read_at)
      VALUES (${user!.id}, ${source!.id}, 'removed-edited', NOW(), NOW() - INTERVAL '1 day')`;

    expect(await listedIds(source!.id, user!.id)).toEqual([kept]);

    await client`DELETE FROM articles WHERE id = ${removed}`;
    const relisted = await addArticle(source!.id, "removed");
    expect(relisted).not.toBe(removed);

    expect(await listedIds(source!.id, user!.id)).toEqual([kept]);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

test("paging is capped and a cursor straddling equal timestamps loses no row", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const articlesDataService = new ArticlesDataService(drizzleConnection);
  const total = articlePageSize + 50;

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [user] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('pager@example.test', 'pager', 'x') RETURNING id`;
    const [source] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url, kind, last_success, not_before)
      VALUES ('https://pager.test/feed', 'https://pager.test', 'feed', NOW(), NOW())
      RETURNING id`;
    await client`
      INSERT INTO user_sources (user_id, source_id, name, created_at)
      VALUES (${user!.id}, ${source!.id}, 'sub', NOW() - INTERVAL '60 days')`;

    await client`
      INSERT INTO articles (source_id, guid, author, title, url, content, published_at, updated_at, last_seen_in_feed_at)
      SELECT ${source!.id}, 'a' || n, 'a', 't', '', 'body',
             NOW() - (n / 30) * INTERVAL '1 minute', NOW(), NOW()
      FROM generate_series(1, ${total}) AS n`;

    const first = await articlesDataService.getUserArticlesForSources(
      [source!.id],
      user!.id,
    );
    expect(first).toHaveLength(articlePageSize);

    const cursor = first.at(-1)!;
    const second = await articlesDataService.getUserArticlesForSources(
      [source!.id],
      user!.id,
      cursor.id,
    );
    expect(second).toHaveLength(total - articlePageSize);

    const paged = [...first, ...second].map((article) => article.id);
    expect(new Set(paged).size).toBe(total);
    const expected = await client<{ id: string }[]>`
      SELECT id FROM articles ORDER BY published_at DESC, id DESC`;
    expect(paged).toEqual(expected.map((row) => Number(row.id)));
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

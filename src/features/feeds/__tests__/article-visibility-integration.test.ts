import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { articlePageSize } from "#shared/contracts/responses.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { migrateDatabase } from "../../../migrator.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

function requireDisposableDatabaseUrl() {
  const databaseUrl = process.env["MIGRATION_TEST_DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("MIGRATION_TEST_DATABASE_URL is required");
  }
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!/(?:^|[_-])(?:disposable|migration_test|test)(?:[_-]|$)/i.test(name)) {
    throw new Error(
      "MIGRATION_TEST_DATABASE_URL must target a clearly disposable database",
    );
  }
  return databaseUrl;
}

// Removing an article is the only user-level state this app writes, and it
// has to stay removed -- through the article row being pruned and the feed
// listing that guid again, which is what used to bring removals back unread
// under a fresh id, and through the publisher editing the item, which bumps
// articles.updated_at.
test("a removal survives its article row being pruned and re-listed", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const articlesDataService = new ArticlesDataService(drizzleConnection);

  // articles.id is bigint, which this driver hands back as a string --
  // unlike the drizzle mapping the service under test goes through.
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
    // Removed on a row that also carries a legacy read_at older than the
    // article's updated_at -- the publisher edited it after that stamp.
    // Nothing writes read_at any more, but rows predating that still have
    // one, and hiding a removal used to depend on it being NULL.
    await addArticle(source!.id, "removed-edited");

    await client`
      INSERT INTO user_articles (user_id, source_id, guid, deleted_at)
      VALUES (${user!.id}, ${source!.id}, 'removed', NOW())`;
    await client`
      INSERT INTO user_articles (user_id, source_id, guid, deleted_at, read_at)
      VALUES (${user!.id}, ${source!.id}, 'removed-edited', NOW(), NOW() - INTERVAL '1 day')`;

    expect(await listedIds(source!.id, user!.id)).toEqual([kept]);

    // What cleanupOrphanedData does to an article every subscriber has
    // removed and the feed appears to have dropped, followed by the feed
    // listing that same guid again.
    await client`DELETE FROM articles WHERE id = ${removed}`;
    const relisted = await addArticle(source!.id, "removed");
    expect(relisted).not.toBe(removed);

    expect(await listedIds(source!.id, user!.id)).toEqual([kept]);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

// A folder can fan out to hundreds of sources, so the list has to come back
// one page at a time. The cursor is a row comparison on (published_at, id)
// because published_at is not unique -- a feed publishing a batch on one
// timestamp straddles the page boundary, and ordering by published_at alone
// would repeat or skip rows there.
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

    // 30 articles share each published_at, so the page boundary lands inside
    // a run of ties rather than between two distinct timestamps.
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

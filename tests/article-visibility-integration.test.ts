import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { migrateDatabase } from "../src/migrator.ts";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

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
// has to stay removed: the feed re-listing the item (or the publisher
// touching it, which bumps articles.updated_at) must not put it back in
// the list. user_articles.read_at is legacy -- nothing writes it any more,
// but rows predating that still carry it, and the list query used to hide
// removals only as a side effect of comparing against it.
test("a removed article stays out of the list and the unread count", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const articlesDataService = new ArticlesDataService(drizzleConnection);

  const addArticle = async (sourceId: number, guid: string) => {
    const [article] = await client<{ id: number }[]>`
      INSERT INTO articles (source_id, guid, author, title, url, content, published_at, updated_at, last_seen_in_feed_at)
      VALUES (${sourceId}, ${guid}, 'a', 't', '', 'body', NOW(), NOW(), NOW())
      RETURNING id`;
    return article!.id;
  };

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
    // Same removal, on a row that also carries a legacy read_at older than
    // the article's own updated_at -- the publisher edited it after the
    // read stamp, which is what used to resurface it.
    const removedThenEdited = await addArticle(source!.id, "removed-edited");

    await client`
      INSERT INTO user_articles (user_id, article_id, deleted_at)
      VALUES (${user!.id}, ${removed}, NOW())`;
    await client`
      INSERT INTO user_articles (user_id, article_id, deleted_at, read_at)
      VALUES (${user!.id}, ${removedThenEdited}, NOW(), NOW() - INTERVAL '1 day')`;

    const listed = await articlesDataService.getUserArticlesForSources(
      [source!.id],
      user!.id,
    );
    expect(listed.map((article) => article.id)).toEqual([kept]);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

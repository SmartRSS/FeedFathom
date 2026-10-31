import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

// The Today view sends no source ids and the options below (see
// routes/articles.ts), so the data service alone decides which subscriptions
// it spans and where the 24 hours end.
test("the Today view spans every subscription and only the last 24 hours", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const articlesDataService = new ArticlesDataService(
    createDrizzleConnection(databaseUrl),
  );

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [reader] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('reader@example.test', 'reader', 'x')
      RETURNING id`;
    await client`
      INSERT INTO sources (url, home_url, kind, last_success, not_before)
      VALUES ('https://one.test/feed', 'https://one.test', 'feed', NOW(), NOW()),
             ('https://two.test/feed', 'https://two.test', 'feed', NOW(), NOW()),
             ('https://unsubscribed.test/feed', 'https://unsubscribed.test', 'feed', NOW(), NOW())`;
    await client`
      INSERT INTO user_sources (user_id, source_id, name, created_at)
      SELECT ${reader!.id}, id, 'feed', NOW() - INTERVAL '60 days'
      FROM sources
      WHERE url <> 'https://unsubscribed.test/feed'`;
    // An hour either side of the edge, on every source.
    await client`
      INSERT INTO articles (source_id, guid, author, title, url, content, published_at, updated_at, last_seen_in_feed_at)
      SELECT sources.id, age.label, 'a', sources.home_url || ' ' || age.label, '', '',
             NOW() - age.span, NOW(), NOW()
      FROM sources
      CROSS JOIN (VALUES ('23h', INTERVAL '23 hours'), ('25h', INTERVAL '25 hours')) AS age(label, span)`;

    const today = await articlesDataService.getUserArticlesForSources(
      [],
      reader!.id,
      undefined,
      undefined,
      { allSubscribed: true, publishedWithinHours: 24 },
    );

    expect(today.map((article) => article.title).toSorted()).toEqual([
      "https://one.test 23h",
      "https://two.test 23h",
    ]);
  } finally {
    await client.end();
  }
});

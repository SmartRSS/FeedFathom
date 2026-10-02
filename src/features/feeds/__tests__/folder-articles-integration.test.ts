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

// #976: a folder is scoped by id on the server, so it is not bounded by the
// 500-id cap on an explicit source list, and the folder id authorizes nothing
// by itself -- the user's own subscriptions filed in it do.
test("lists a folder's articles by folder id, past 500 sources", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const articlesDataService = new ArticlesDataService(
    createDrizzleConnection(databaseUrl),
  );
  const titles = async (userId: number, folderId: number) =>
    (
      await articlesDataService.getUserArticlesForSources(
        [],
        userId,
        undefined,
        "all",
        { folderId },
      )
    ).map((article) => article.title);

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [reader, other] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('reader@example.test', 'reader', 'x'),
             ('other@example.test', 'other', 'x')
      RETURNING id`;
    const [big, elsewhere] = await client<{ id: number }[]>`
      INSERT INTO user_folders (user_id, name)
      VALUES (${reader!.id}, 'big'), (${reader!.id}, 'elsewhere')
      RETURNING id`;
    await client`
      INSERT INTO sources (url, home_url, kind, last_success, not_before)
      SELECT 'https://feed' || n || '.test/feed', 'https://feed' || n || '.test',
             'feed', NOW(), NOW()
      FROM generate_series(1, 502) AS n`;
    // 501 sources in the folder, one filed elsewhere.
    await client`
      INSERT INTO user_sources (user_id, source_id, name, parent_id, created_at)
      SELECT ${reader!.id}, id, 'feed',
             CASE WHEN url = 'https://feed502.test/feed' THEN ${elsewhere!.id}::int ELSE ${big!.id}::int END,
             NOW() - INTERVAL '60 days'
      FROM sources`;
    // Only the first and the 501st source in the folder publish, so both
    // ends of an over-cap folder are asserted, plus the one outside it.
    await client`
      INSERT INTO articles (source_id, guid, author, title, url, content, published_at, updated_at, last_seen_in_feed_at)
      SELECT id, 'g', 'a', url, '', '', NOW(), NOW(), NOW()
      FROM sources
      WHERE url IN ('https://feed1.test/feed', 'https://feed501.test/feed', 'https://feed502.test/feed')`;

    expect((await titles(reader!.id, big!.id)).toSorted()).toEqual([
      "https://feed1.test/feed",
      "https://feed501.test/feed",
    ]);
    expect(await titles(reader!.id, elsewhere!.id)).toEqual([
      "https://feed502.test/feed",
    ]);
    // Someone else's folder id matches none of the caller's subscriptions.
    expect(await titles(other!.id, big!.id)).toEqual([]);
  } finally {
    await client.end();
  }
});

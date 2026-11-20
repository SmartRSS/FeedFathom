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

test("searches title and body of subscribed articles only", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const articlesDataService = new ArticlesDataService(drizzleConnection);

  const addArticle = async (
    sourceId: number,
    guid: string,
    title: string,
    content: string,
  ) => {
    const [article] = await client<{ id: string }[]>`
      INSERT INTO articles (source_id, guid, author, title, url, content, published_at, updated_at, last_seen_in_feed_at)
      VALUES (${sourceId}, ${guid}, 'a', ${title}, '', ${content}, NOW(), NOW(), NOW())
      RETURNING id`;
    return Number(article!.id);
  };
  const search = async (userId: number, query: string) =>
    (
      await articlesDataService.getUserArticlesForSources(
        [],
        userId,
        undefined,
        "all",
        { allSubscribed: true, query },
      )
    )
      .map((article) => article.title)
      .toSorted();

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [user] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('reader@example.test', 'reader', 'x') RETURNING id`;
    const [subscribed] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url, kind, last_success, not_before)
      VALUES ('https://feed.test/feed', 'https://feed.test', 'feed', NOW(), NOW())
      RETURNING id`;
    const [stranger] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url, kind, last_success, not_before)
      VALUES ('https://other.test/feed', 'https://other.test', 'feed', NOW(), NOW())
      RETURNING id`;
    await client`
      INSERT INTO user_sources (user_id, source_id, name, created_at)
      VALUES (${user!.id}, ${subscribed!.id}, 'sub', NOW() - INTERVAL '60 days')`;

    const networking = await addArticle(
      subscribed!.id,
      "networking",
      "Kubernetes networking",
      "<p>Ingress controllers explained</p>",
    );
    await addArticle(
      subscribed!.id,
      "sourdough",
      "Sourdough starter",
      "<p>Flour, water, patience</p>",
    );
    await addArticle(
      stranger!.id,
      "unsubscribed",
      "Kubernetes secrets",
      "<p>Not for this reader</p>",
    );

    expect(await search(user!.id, "kubernetes")).toEqual([
      "Kubernetes networking",
    ]);
    expect(await search(user!.id, "flour")).toEqual(["Sourdough starter"]);
    expect(await search(user!.id, "controller")).toEqual([
      "Kubernetes networking",
    ]);
    expect(await search(user!.id, "p")).toEqual([]);
    expect(await search(user!.id, "kubernetes sourdough")).toEqual([]);
    expect(await search(user!.id, "the")).toEqual([]);

    await client`UPDATE articles SET title = 'Service meshes' WHERE id = ${networking}`;
    expect(await search(user!.id, "kubernetes")).toEqual([]);
    expect(await search(user!.id, "mesh")).toEqual(["Service meshes"]);
  } finally {
    await client.end();
  }
});

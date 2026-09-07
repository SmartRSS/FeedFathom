import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { migrateDatabase } from "../../../migrator.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

// The article list and the unread badge are two queries answering the same
// question, and a disagreement between them is an unread count with nothing
// behind it -- the failure that is hardest to notice. They now share one
// expression (article-read-state.ts); this holds them to it across every state
// a user_articles row can be in.
test("the article list and the unread count agree in every read state", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const articlesDataService = new ArticlesDataService(drizzleConnection);
  const userSourcesDataService = new UserSourcesDataService(
    drizzleConnection,
    new FoldersDataService(drizzleConnection),
    new SourcesDataService(drizzleConnection, {
      async add() {
        return undefined;
      },
    }),
  );

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

    // updated_at NULL is the ordinary case: only an edit sets it.
    const addArticle = async (guid: string, updatedAt: null | string) => {
      const [article] = await client<{ id: string }[]>`
        INSERT INTO articles (source_id, guid, author, title, url, content, published_at, updated_at, last_seen_in_feed_at)
        VALUES (${source!.id}, ${guid}, 'a', ${guid}, '', 'body', NOW(),
                ${updatedAt === null ? null : client`NOW() - ${updatedAt}::interval`}, NOW())
        RETURNING id`;
      return Number(article!.id);
    };
    const setState = async (
      guid: string,
      deletedAt: null | string,
      readAt: null | string,
    ) => {
      await client`
        INSERT INTO user_articles (user_id, source_id, guid, deleted_at, read_at)
        VALUES (${user!.id}, ${source!.id}, ${guid},
                ${deletedAt === null ? null : client`NOW()`},
                ${readAt === null ? null : client`NOW() - ${readAt}::interval`})`;
    };

    const untouched = await addArticle("untouched", null);
    const removed = await addArticle("removed", null);
    // A state row that is neither removed nor read. Nothing wrote one before
    // read state existed, and it is exactly the row the old list query lost:
    // `updated_at > NULL` is NULL, which made the whole condition NULL.
    const stateOnly = await addArticle("state-only", null);
    const read = await addArticle("read", null);
    const readThenEdited = await addArticle("read-then-edited", "1 hour");
    const readAfterEdit = await addArticle("read-after-edit", "3 hours");

    await setState("removed", "now", null);
    await setState("state-only", null, null);
    await setState("read", null, "1 minute");
    // Edited an hour ago, read two hours ago: unread again.
    await setState("read-then-edited", null, "2 hours");
    // Edited three hours ago, read two: still read.
    await setState("read-after-edit", null, "2 hours");

    const listed = (
      await articlesDataService.getUserArticlesForSources(
        [source!.id],
        user!.id,
      )
    )
      .map((article) => article.id)
      .toSorted((left, right) => left - right);

    expect(listed).toEqual(
      [untouched, stateOnly, readThenEdited].toSorted(
        (left, right) => left - right,
      ),
    );
    expect(listed).not.toContain(removed);
    expect(listed).not.toContain(read);
    expect(listed).not.toContain(readAfterEdit);

    await userSourcesDataService.recomputeUnreadCounts([source!.id], user!.id);
    const [counted] = await client<{ unread_count: number }[]>`
      SELECT unread_count FROM user_sources WHERE user_id = ${user!.id}`;

    expect(counted!.unread_count).toBe(listed.length);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

// A subscription with no articles at all: the LEFT JOIN leaves ua.user_id
// NULL, which reads as unread unless the article row itself is tested for.
test("an empty subscription counts zero unread", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const userSourcesDataService = new UserSourcesDataService(
    drizzleConnection,
    new FoldersDataService(drizzleConnection),
    new SourcesDataService(drizzleConnection, {
      async add() {
        return undefined;
      },
    }),
  );

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [user] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('empty@example.test', 'empty', 'x') RETURNING id`;
    const [source] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url, kind, last_success, not_before)
      VALUES ('https://empty.test/feed', 'https://empty.test', 'feed', NOW(), NOW())
      RETURNING id`;
    await client`
      INSERT INTO user_sources (user_id, source_id, name, created_at, unread_count)
      VALUES (${user!.id}, ${source!.id}, 'sub', NOW() - INTERVAL '60 days', 7)`;

    await userSourcesDataService.recomputeUnreadCounts([source!.id], user!.id);
    const [counted] = await client<{ unread_count: number }[]>`
      SELECT unread_count FROM user_sources WHERE user_id = ${user!.id}`;

    expect(counted!.unread_count).toBe(0);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

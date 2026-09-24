import { afterAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { requireDisposableDatabaseUrl } from "#features/feeds/__tests__/disposable-database-url.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { FeedParser } from "#features/feeds/feed-parser.ts";
import { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import { cleanupOrphanedData } from "#features/feeds/retention.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import { HttpClient } from "#platform/http/http-client.ts";
import { RedirectMap } from "#platform/http/redirect-map.ts";
import { migrateDatabase } from "../../../migrator.ts";

// A poll of a feed that has not changed used to rewrite every article row to
// move last_seen_in_feed_at and then recount every subscriber's badge (#897).
// These run the real parser against a real database so the throttle is held
// to what it must not break: new subscriptions seeing current articles, edits
// reaching the badge, and the gone-from-feed cull telling present from
// dropped.

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);
const feedUrl = "https://1.1.1.1/feed";

const databaseUrl = requireDisposableDatabaseUrl();
const client = new SQL(databaseUrl);
const drizzleConnection = createDrizzleConnection(databaseUrl);
const articlesDataService = new ArticlesDataService(drizzleConnection);
const sourcesDataService = new SourcesDataService(drizzleConnection);
const userSourcesDataService = new UserSourcesDataService(
  drizzleConnection,
  new FoldersDataService(drizzleConnection),
  sourcesDataService,
);

let recounts = 0;
let sourceId = 0;

afterAll(async () => {
  await drizzleConnection.$client.close();
  await client.close();
});

beforeEach(async () => {
  recounts = 0;
  await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
  await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
  await client`CREATE SCHEMA "public"`;
  await migrateDatabase(databaseUrl, migrationsFolder);
  const [source] = await client<{ id: number }[]>`
    INSERT INTO sources (url, home_url, kind, last_success, not_before)
    VALUES (${feedUrl}, 'https://1.1.1.1', 'feed', NOW(), NOW())
    RETURNING id`;
  sourceId = source!.id;
});

// One date for every parse: pubDate is also the article's updated_at, so a
// clock second ticking over between two parses would read as an edit.
const pubDate = new Date().toUTCString();

function rss(items: { content: string; guid: string }[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Feed</title><link>https://1.1.1.1/</link>
${items
  .map(
    (item) => `<item><guid>${item.guid}</guid><title>${item.guid}</title>
<link>https://1.1.1.1/${item.guid}</link><description>${item.content}</description>
<pubDate>${pubDate}</pubDate></item>`,
  )
  .join("\n")}
</channel></rss>`;
}

// A fresh HTTP client per parse, so every parse is a full 200 with the body
// given -- the costliest case, since nothing upstream short-circuits it.
async function parse(body: string) {
  const redirectRedis = {
    del: async () => 0,
    get: async () => null,
    mget: async () => [],
    scan: async (): Promise<[string, string[]]> => ["0", []],
    set: async () => "OK",
  };
  const parser = new FeedParser(
    articlesDataService,
    new HttpClient(createFakeHttpRedis(), {
      transport: async () => ({
        body: Readable.from([body]),
        destroy() {},
        headers: new Headers({ "content-type": "application/rss+xml" }),
        status: 200,
        url: feedUrl,
      }),
    }),
    sourcesDataService,
    {
      claimWebSubSubscribeAttempt: async () => false,
      markWebSubFailed: async () => {},
      recordWebSubDiscovery: async () => {
        throw new Error("no WebSub in these feeds");
      },
    },
    new RedirectMap(redirectRedis),
    {
      recomputeUnreadCounts: async (sourceIds, userId) => {
        recounts++;
        await userSourcesDataService.recomputeUnreadCounts(sourceIds, userId);
      },
    },
  );
  await parser.parseSource({ id: sourceId, url: feedUrl });
}

async function subscribe(email: string, createdAt = client`NOW()`) {
  const [user] = await client<{ id: number }[]>`
    INSERT INTO users (email, name, password)
    VALUES (${email}, ${email}, 'x') RETURNING id`;
  await client`
    INSERT INTO user_sources (user_id, source_id, name, created_at)
    VALUES (${user!.id}, ${sourceId}, 'sub', ${createdAt})`;
  return user!.id;
}

async function rowVersions() {
  const rows = await client<{ guid: string; xmin: string }[]>`
    SELECT guid, xmin::text AS xmin FROM articles ORDER BY guid`;
  return Object.fromEntries(rows.map((row) => [row.guid, row.xmin]));
}

async function unreadCount(userId: number) {
  const [row] = await client<{ unread_count: number }[]>`
    SELECT unread_count FROM user_sources WHERE user_id = ${userId}`;
  return row!.unread_count;
}

const items = [
  { content: "first body", guid: "one" },
  { content: "second body", guid: "two" },
  { content: "third body", guid: "three" },
];

test("a second parse of an unchanged feed writes no article row and skips the recount", async () => {
  const userId = await subscribe(
    "reader@example.test",
    client`NOW() - INTERVAL '60 days'`,
  );
  await parse(rss(items));
  expect(recounts).toBe(1);
  expect(await unreadCount(userId)).toBe(3);
  const before = await rowVersions();

  await parse(rss(items));

  expect(await rowVersions()).toEqual(before);
  expect(recounts).toBe(1);
  expect(await unreadCount(userId)).toBe(3);
});

test("an edited article is still rewritten and the badge recounted", async () => {
  const userId = await subscribe(
    "reader@example.test",
    client`NOW() - INTERVAL '60 days'`,
  );
  await parse(rss(items));
  await client`
    INSERT INTO user_articles (user_id, source_id, guid, read_at)
    VALUES (${userId}, ${sourceId}, 'two', NOW())`;
  await userSourcesDataService.recomputeUnreadCounts([sourceId], userId);
  expect(await unreadCount(userId)).toBe(2);
  const before = await rowVersions();

  await parse(
    rss(
      items.map((item) =>
        item.guid === "two" ? { ...item, content: "edited body" } : item,
      ),
    ),
  );

  const after = await rowVersions();
  expect(after["two"]).not.toBe(before["two"]);
  expect(after["one"]).toBe(before["one"]);
  expect(after["three"]).toBe(before["three"]);
  expect(recounts).toBe(2);
  // Read before the edit, so the edit makes it unread again.
  expect(await unreadCount(userId)).toBe(3);
});

test("a subscription created between parses of an unchanged feed sees its current articles", async () => {
  await subscribe("early@example.test", client`NOW() - INTERVAL '60 days'`);
  await parse(rss(items));
  expect(recounts).toBe(1);

  // Inserted directly, as OPML import does: no article is written for it.
  const lateUserId = await subscribe("late@example.test");
  await parse(rss(items));

  expect(recounts).toBe(2);
  expect(await unreadCount(lateUserId)).toBe(3);
  const listed = await articlesDataService.getUserArticlesForSources(
    [sourceId],
    lateUserId,
  );
  expect(listed.map((article) => article.title).toSorted()).toEqual([
    "one",
    "three",
    "two",
  ]);
});

// Time is moved by shifting every stored timestamp the rules read back by
// the step, which is what the clock moving forward by it looks like to them.
async function elapse(minutes: number) {
  const step = client`${minutes} * INTERVAL '1 minute'`;
  await client`UPDATE articles SET last_seen_in_feed_at = last_seen_in_feed_at - ${step}`;
  await client`UPDATE user_sources SET created_at = created_at - ${step}`;
  await client`
    UPDATE sources SET last_success = last_success - ${step},
                       not_before = not_before - ${step},
                       last_attempt = last_attempt - ${step}`;
}

test("the throttle never lets the cull take an article that is still in the feed", async () => {
  const userId = await subscribe(
    "reader@example.test",
    client`NOW() - INTERVAL '60 days'`,
  );
  const present = { content: "present body", guid: "present" };
  const dropped = { content: "dropped body", guid: "dropped" };
  // Removed by the only subscriber, so last_seen_in_feed_at is all that
  // keeps either of them.
  await client`
    INSERT INTO user_articles (user_id, source_id, guid, deleted_at)
    VALUES (${userId}, ${sourceId}, 'present', NOW()),
           (${userId}, ${sourceId}, 'dropped', NOW())`;
  const guids = async () =>
    (await client<{ guid: string }[]>`SELECT guid FROM articles`)
      .map((row) => row.guid)
      .toSorted();

  await parse(rss([present, dropped]));
  await elapse(45);
  await parse(rss([present, dropped]));

  // 45 minutes a step straddles the one-hour throttle: the present article
  // is re-stamped on every other parse. The buffer floor is a day, and the
  // dropped article, last stamped by the first parse, is a day old at the
  // end of step 31.
  for (let step = 1; step <= 34; step++) {
    // eslint-disable-next-line no-await-in-loop -- Each step reads the last.
    await elapse(45);
    // eslint-disable-next-line no-await-in-loop -- Each step reads the last.
    await parse(rss([present]));
    // eslint-disable-next-line no-await-in-loop -- Each step reads the last.
    await cleanupOrphanedData(drizzleConnection, 365, 365, 730);
    // eslint-disable-next-line no-await-in-loop -- Each step reads the last.
    const remaining = await guids();
    expect(remaining).toContain("present");
    if (step <= 30) expect(remaining).toContain("dropped");
  }

  expect(await guids()).toEqual(["present"]);
});

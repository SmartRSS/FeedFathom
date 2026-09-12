import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { cleanupOrphanedData } from "#features/feeds/retention.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "./disposable-database-url.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

// Deleting an article cascades away every user's record of having removed
// it, so a false "gone from the feed" reading doesn't just delete an
// article -- the next fetch that lists the item again brings it back
// unread. These cover what the reading has to get right.
test("only prunes articles the feed has really stopped listing", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);

  const addSource = async (url: string, kind: string, pollInterval: string) => {
    const [source] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url, kind, last_success, not_before)
      VALUES (${url}, 'https://example.test', ${kind}, NOW(),
              NOW() + CAST(${pollInterval} AS interval))
      RETURNING id`;
    return source!.id;
  };
  const addArticle = async (
    sourceId: number,
    guid: string,
    lastSeen: string,
  ) => {
    const [article] = await client<{ id: number }[]>`
      INSERT INTO articles (source_id, guid, author, title, url, content, published_at, last_seen_in_feed_at)
      VALUES (${sourceId}, ${guid}, 'a', 't', '', 'body', NOW(), NOW() - CAST(${lastSeen} AS interval))
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

    // Polled every 5 minutes, so five days unseen is ~1400 fetches without
    // it: genuinely dropped from the feed.
    const fastFeed = await addSource(
      "https://fast.test/feed",
      "feed",
      "5 minutes",
    );
    // Advertises a two-day max-age, so three days unseen is one missed
    // fetch -- the flakiness this rule must not mistake for removal.
    const slowFeed = await addSource(
      "https://slow.test/feed",
      "feed",
      "2 days",
    );
    // No feed at all: every delivery stamps last_success, which used to
    // make every earlier newsletter look dropped.
    const mailbox = await addSource("news@example.test", "email", "5 minutes");

    for (const sourceId of [fastFeed, slowFeed]) {
      // eslint-disable-next-line no-await-in-loop -- two fixture rows.
      await client`
        INSERT INTO user_sources (user_id, source_id, name, created_at)
        VALUES (${user!.id}, ${sourceId}, 'sub', NOW() - INTERVAL '60 days')`;
    }
    // The mailbox subscription predates the old deliveries below: a current
    // subscriber has had the chance to see them, so their fate is decided by
    // the email age rule, not the nobody-ever-saw-it rule above it.
    await client`
      INSERT INTO user_sources (user_id, source_id, name, created_at)
      VALUES (${user!.id}, ${mailbox}, 'sub', NOW() - INTERVAL '100 days')`;

    const goneForGood = await addArticle(fastFeed, "gone", "5 days");
    const stillSubscribed = await addArticle(fastFeed, "not-removed", "5 days");
    const missedOneFetch = await addArticle(slowFeed, "flaky", "3 days");
    // Email prunes on flat delivery age, deletions not gating it: a
    // 30-day-old delivery is far inside the window, and both 91-day-old
    // ones are outside it -- one recorded as deleted, one that an active
    // subscriber never deleted, which used to keep it forever.
    const oldNewsletter = await addArticle(mailbox, "letter", "30 days");
    const prunableNewsletter = await addArticle(mailbox, "stale", "91 days");
    const hoardedNewsletter = await addArticle(mailbox, "hoarded", "91 days");

    for (const guid of ["gone", "flaky", "letter", "stale"]) {
      // eslint-disable-next-line no-await-in-loop -- four fixture rows.
      await client`
        INSERT INTO user_articles (user_id, source_id, guid, deleted_at)
        SELECT ${user!.id}, source_id, guid, NOW()
        FROM articles WHERE guid = ${guid}`;
    }

    await cleanupOrphanedData(drizzleConnection, 365, 365, 730);

    const rows = await client<{ id: number }[]>`
      SELECT id FROM articles ORDER BY id`;
    expect(rows.map((row) => row.id)).toEqual([
      stillSubscribed,
      missedOneFetch,
      oldNewsletter,
    ]);
    expect(rows.map((row) => row.id)).not.toContain(goneForGood);
    expect(rows.map((row) => row.id)).not.toContain(prunableNewsletter);
    expect(rows.map((row) => row.id)).not.toContain(hoardedNewsletter);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

// Cleanup deletes article rows straight through SQL, so the unread badge a
// subscriber sees is stale the moment the prune commits (#812): an unread
// newsletter aged past retention used to keep its count until some
// unrelated event recounted the source. cleanupOrphanedData reports the
// sources it shrank; the recompose of the counter -- the same call the
// worker makes -- must bring the badge back in step with the list.
test("reports pruned sources so their unread totals can be recounted", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const userSourcesDataService = new UserSourcesDataService(
    drizzleConnection,
    new FoldersDataService(drizzleConnection),
    new SourcesDataService(drizzleConnection),
  );

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [user] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('reader@example.test', 'reader', 'x') RETURNING id`;
    const [mailbox] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url, kind, last_success, not_before)
      VALUES ('news@example.test', 'https://example.test', 'email', NOW(),
              NOW() + INTERVAL '5 minutes')
      RETURNING id`;
    // Subscribed well before both deliveries, so both are visible to the
    // subscription and both sit in the unread count before the prune.
    await client`
      INSERT INTO user_sources (user_id, source_id, name, unread_count, created_at)
      VALUES (${user!.id}, ${mailbox!.id}, 'sub', 2, NOW() - INTERVAL '100 days')`;
    for (const guid of ["fresh", "stale"]) {
      // eslint-disable-next-line no-await-in-loop -- two fixture rows.
      await client`
        INSERT INTO articles (source_id, guid, author, title, url, content, published_at, last_seen_in_feed_at)
        VALUES (${mailbox!.id}, ${guid}, 'a', 't', '', 'body', NOW(),
                NOW() - CAST(${guid === "fresh" ? "30 days" : "91 days"} AS interval))`;
    }

    const prunedSourceIds = await cleanupOrphanedData(
      drizzleConnection,
      365,
      365,
      730,
    );
    expect(prunedSourceIds).toEqual([mailbox!.id]);

    const [stale] = await client<{ unread: number }[]>`
      SELECT unread_count AS unread FROM user_sources WHERE source_id = ${mailbox!.id}`;
    expect(stale!.unread).toBe(2);

    await userSourcesDataService.recomputeUnreadCounts(prunedSourceIds);
    const [recounted] = await client<{ unread: number }[]>`
      SELECT unread_count AS unread FROM user_sources WHERE source_id = ${mailbox!.id}`;
    expect(recounted!.unread).toBe(1);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

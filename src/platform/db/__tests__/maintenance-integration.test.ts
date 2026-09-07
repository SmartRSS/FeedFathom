import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { cleanupOrphanedData } from "#platform/db/maintenance.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
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

    for (const sourceId of [fastFeed, slowFeed, mailbox]) {
      // eslint-disable-next-line no-await-in-loop -- three fixture rows.
      await client`
        INSERT INTO user_sources (user_id, source_id, name, created_at)
        VALUES (${user!.id}, ${sourceId}, 'sub', NOW() - INTERVAL '60 days')`;
    }

    const goneForGood = await addArticle(fastFeed, "gone", "5 days");
    const stillSubscribed = await addArticle(fastFeed, "not-removed", "5 days");
    const missedOneFetch = await addArticle(slowFeed, "flaky", "3 days");
    const oldNewsletter = await addArticle(mailbox, "letter", "30 days");

    for (const guid of ["gone", "flaky", "letter"]) {
      // eslint-disable-next-line no-await-in-loop -- three fixture rows.
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
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

// Nothing authenticates the sender of a delivery, and a guid falls back to a
// hash of the raw message, so the same newsletter re-sent with a byte of
// padding is a new row. No absence-from-feed reading can catch that -- there
// is no feed -- and waiting for the subscriber to go dormant is exactly
// backwards: an active one is the case that grows.
test("prunes stale email articles even while someone is still reading them", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [user] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('reader@example.test', 'reader', 'x') RETURNING id`;
    const addSource = async (url: string, kind: string) => {
      const [source] = await client<{ id: number }[]>`
        INSERT INTO sources (url, home_url, kind, last_success, not_before)
        VALUES (${url}, 'https://example.test', ${kind}, NOW(),
                NOW() + INTERVAL '5 minutes')
        RETURNING id`;
      await client`
        INSERT INTO user_sources (user_id, source_id, name, created_at)
        VALUES (${user!.id}, ${source!.id}, 'sub', NOW() - INTERVAL '400 days')`;
      return source!.id;
    };
    const addArticle = async (
      sourceId: number,
      guid: string,
      arrived: string,
    ) => {
      const [article] = await client<{ id: number }[]>`
        INSERT INTO articles (source_id, guid, author, title, url, content, published_at, last_seen_in_feed_at)
        VALUES (${sourceId}, ${guid}, 'a', 't', '', 'body', NOW(), NOW() - CAST(${arrived} AS interval))
        RETURNING id`;
      return article!.id;
    };

    const mailbox = await addSource("news@example.test", "email");
    const feed = await addSource("https://feed.test/rss", "feed");
    const flood = await addArticle(mailbox, "padded-resend", "40 days");
    const recentLetter = await addArticle(mailbox, "this-week", "3 days");
    // The same age on a feed source, which still has a feed to be absent
    // from: the rule that reads that is the one deciding its fate, not this.
    const oldFeedArticle = await addArticle(feed, "old-post", "40 days");

    // The subscriber has been active all along, so the dormancy rule cannot
    // fire and 30 days is the whole of what decides this.
    await client`UPDATE users SET last_seen_at = NOW()`;
    await cleanupOrphanedData(drizzleConnection, 365, 30, 730);

    const rows = await client<{ id: number }[]>`
      SELECT id FROM articles ORDER BY id`;
    expect(rows.map((row) => row.id)).toEqual([recentLetter, oldFeedArticle]);
    expect(rows.map((row) => row.id)).not.toContain(flood);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

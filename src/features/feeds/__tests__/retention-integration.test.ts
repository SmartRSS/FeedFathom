import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { cleanupOrphanedData } from "#features/feeds/retention.ts";
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

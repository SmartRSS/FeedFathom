import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { RetentionService } from "#features/feeds/retention.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";

type Connection = ReturnType<typeof createDrizzleConnection>;
const yearLong = {
  ARTICLE_STALE_AFTER_DAYS: 365,
  USER_DORMANT_AFTER_DAYS: 365,
  USER_EXPIRY_DAYS: 730,
};
const prune = (drizzleConnection: Connection, config = yearLong) =>
  new RetentionService(
    drizzleConnection,
    new UserSourcesDataService(
      drizzleConnection,
      new SourcesDataService(drizzleConnection),
    ),
    config,
  ).prune();

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

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

    const fastFeed = await addSource(
      "https://fast.test/feed",
      "feed",
      "5 minutes",
    );
    const slowFeed = await addSource(
      "https://slow.test/feed",
      "feed",
      "2 days",
    );
    const mailbox = await addSource("news@example.test", "email", "5 minutes");

    for (const sourceId of [fastFeed, slowFeed]) {
      // eslint-disable-next-line no-await-in-loop -- two fixture rows.
      await client`
        INSERT INTO user_sources (user_id, source_id, name, created_at)
        VALUES (${user!.id}, ${sourceId}, 'sub', NOW() - INTERVAL '60 days')`;
    }
    await client`
      INSERT INTO user_sources (user_id, source_id, name, created_at)
      VALUES (${user!.id}, ${mailbox}, 'sub', NOW() - INTERVAL '100 days')`;

    const goneForGood = await addArticle(fastFeed, "gone", "5 days");
    const stillSubscribed = await addArticle(fastFeed, "not-removed", "5 days");
    const missedOneFetch = await addArticle(slowFeed, "flaky", "3 days");
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

    await prune(drizzleConnection);

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

test("recounts the unread totals of the sources it pruned", async () => {
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
    const [mailbox] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url, kind, last_success, not_before)
      VALUES ('news@example.test', 'https://example.test', 'email', NOW(),
              NOW() + INTERVAL '5 minutes')
      RETURNING id`;
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

    await prune(drizzleConnection);

    const [recounted] = await client<{ unread: number }[]>`
      SELECT unread_count AS unread FROM user_sources WHERE source_id = ${mailbox!.id}`;
    expect(recounted!.unread).toBe(1);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

test("drops orphaned sources, expired users and sessions, but never every source", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const sourceUrls = async () =>
    (await client<{ url: string }[]>`SELECT url FROM sources ORDER BY url`).map(
      (row) => row.url,
    );

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);
    const [kept, orphan] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url, created_at) VALUES
        ('https://kept.test/feed', 'https://kept.test', NOW() - INTERVAL '2 days'),
        ('https://orphan.test/feed', 'https://orphan.test', NOW() - INTERVAL '2 days')
      RETURNING id`;

    await prune(drizzleConnection);
    expect(await sourceUrls()).toEqual([
      "https://kept.test/feed",
      "https://orphan.test/feed",
    ]);

    const [reader, expired] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password, last_seen_at) VALUES
        ('reader@example.test', 'reader', 'x', NOW()),
        ('gone@example.test', 'gone', 'x', NOW() - INTERVAL '731 days')
      RETURNING id`;
    await client`
      INSERT INTO user_sources (user_id, source_id, name) VALUES
        (${reader!.id}, ${kept!.id}, 'sub'),
        (${expired!.id}, ${orphan!.id}, 'sub')`;
    await client`
      INSERT INTO sessions (sid, user_agent, user_id, expires_at) VALUES
        ('live', 'a', ${reader!.id}, NOW() + INTERVAL '1 day'),
        ('dead', 'a', ${reader!.id}, NOW() - INTERVAL '1 second')`;

    await prune(drizzleConnection);

    expect(await sourceUrls()).toEqual(["https://kept.test/feed"]);
    expect(
      (await client<{ email: string }[]>`SELECT email FROM users`).map(
        (row) => row.email,
      ),
    ).toEqual(["reader@example.test"]);
    expect(
      (await client<{ sid: string }[]>`SELECT sid FROM sessions`).map(
        (row) => row.sid,
      ),
    ).toEqual(["live"]);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

test("prunes articles last seen before a source's earliest subscription", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [early, late] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password) VALUES
        ('early@example.test', 'early', 'x'),
        ('late@example.test', 'late', 'x')
      RETURNING id`;
    const [feed, untouched] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url) VALUES
        ('https://feed.test/feed', 'https://feed.test'),
        ('https://untouched.test/feed', 'https://untouched.test')
      RETURNING id`;
    await client`
      INSERT INTO user_sources (user_id, source_id, name, unread_count, created_at) VALUES
        (${early!.id}, ${feed!.id}, 'sub', 3, NOW() - INTERVAL '30 days'),
        (${late!.id}, ${feed!.id}, 'sub', 3, NOW() - INTERVAL '2 days'),
        (${early!.id}, ${untouched!.id}, 'sub', 0, NOW() - INTERVAL '30 days')`;
    for (const [sourceId, guid, lastSeen] of [
      [feed!.id, "before-anyone", "40 days"],
      [feed!.id, "between-subscriptions", "10 days"],
      [feed!.id, "recent", "1 day"],
      [untouched!.id, "after-subscription", "10 days"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- four fixture rows.
      await client`
        INSERT INTO articles (source_id, guid, author, title, url, content, published_at, last_seen_in_feed_at)
        VALUES (${sourceId}, ${guid}, 'a', 't', '', 'body', NOW(),
                NOW() - CAST(${lastSeen} AS interval))`;
    }

    await prune(drizzleConnection, {
      ARTICLE_STALE_AFTER_DAYS: 0,
      USER_DORMANT_AFTER_DAYS: 0,
      USER_EXPIRY_DAYS: 0,
    });
    expect(
      (
        await client<{ guid: string }[]>`SELECT guid FROM articles ORDER BY id`
      ).map((row) => row.guid),
    ).toEqual(["between-subscriptions", "recent", "after-subscription"]);

    expect([
      ...(await client<{ unread: number; user_id: number }[]>`
        SELECT user_id, unread_count AS unread FROM user_sources
        WHERE source_id = ${feed!.id} ORDER BY user_id`),
    ]).toEqual([
      { unread: 2, user_id: early!.id },
      { unread: 1, user_id: late!.id },
    ]);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

import { afterAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import { HttpClient } from "#platform/http/http-client.ts";
import { UsersDataService } from "#features/auth/user-data-service.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { ArticleImporter } from "#features/feeds/article-import.ts";
import { FeedParser } from "#features/feeds/feed-parser.ts";
import { RedirectMap } from "#features/feeds/redirect-map.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { EmailHandler } from "#features/mail-ingest/email-handler.ts";
import {
  createReaderRoutes,
  type ReaderRouteServices,
} from "#features/reader/routes.ts";
import { migrateDatabase } from "../../../migrator.ts";

// One feed of each kind, from the bytes on the wire to what a signed-in
// reader gets back from /api/articles and /api/article: the real parser,
// importer, data services, session check and routes over a real database.
// Only the network is a stand-in.

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
  sourcesDataService,
);
const usersDataService = new UsersDataService(drizzleConnection);
const articleImporter = new ArticleImporter(
  articlesDataService,
  userSourcesDataService,
  { publish() {} },
);
const reader = createReaderRoutes(
  strictFake<ReaderRouteServices>(
    {
      articlesDataService,
      foldersDataService: strictFake({}, "foldersDataService"),
      userSourcesDataService,
      usersDataService,
    },
    "readerServices",
  ),
);

afterAll(async () => {
  await drizzleConnection.$client.close();
  await client.close();
});

beforeEach(async () => {
  await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
  await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
  await client`CREATE SCHEMA "public"`;
  await migrateDatabase(databaseUrl, migrationsFolder);
});

// A source with one active subscriber and that subscriber's session cookie.
async function subscribed(url: string, kind: "email" | "feed" = "feed") {
  const [source] = await client<{ id: number }[]>`
    INSERT INTO sources (url, home_url, kind)
    VALUES (${url}, 'https://1.1.1.1', ${kind}) RETURNING id`;
  const [user] = await client<{ id: number }[]>`
    INSERT INTO users (email, name, password, status)
    VALUES ('reader@example.test', 'reader', 'x', 'active') RETURNING id`;
  await client`
    INSERT INTO user_sources (user_id, source_id, name, created_at)
    VALUES (${user!.id}, ${source!.id}, 'sub', NOW() - INTERVAL '1 day')`;
  const sid = await usersDataService.createSession(user!.id, "x", "Browser");
  return { cookie: `sid=${sid}`, sourceId: source!.id };
}

function feedParserServing(body: string, contentType: string, status = 200) {
  return new FeedParser(
    articleImporter,
    new HttpClient(createFakeHttpRedis(), {
      transport: async () => ({
        body: Readable.from([body]),
        destroy() {},
        headers: new Headers({ "content-type": contentType }),
        status,
        url: feedUrl,
      }),
    }),
    sourcesDataService,
    strictFake({}, "websubStateService"),
    new RedirectMap({
      del: async () => 0,
      get: async () => null,
      mget: async () => [],
      scan: async (): Promise<[string, string[]]> => ["0", []],
      set: async () => "OK",
    }),
  );
}

type Listed = { id: number; title: string; url: string };

async function readerSees(cookie: string, sourceId: number) {
  const listResponse = await reader.handle(
    new Request("http://localhost/api/articles", {
      body: JSON.stringify({ sources: [sourceId] }),
      headers: { "content-type": "application/json", cookie },
      method: "POST",
    }),
  );
  expect(listResponse.status).toBe(200);
  const listed: Listed[] = await listResponse.json();
  const contents = await Promise.all(
    listed.map(async ({ id }) => {
      const response = await reader.handle(
        new Request(`http://localhost/api/article?article=${id}`, {
          headers: { cookie },
        }),
      );
      const article: { content: string } = await response.json();
      return article.content;
    }),
  );
  return listed.map(({ title, url }, index) => ({
    content: contents[index],
    title,
    url,
  }));
}

const future = "2099-01-01T00:00:00Z";
const published = "2026-07-22T10:00:00Z";

test.each([
  [
    "RSS",
    "application/rss+xml",
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
<link>https://1.1.1.1/</link><item><guid>rss-1</guid><title>RSS item</title>
<link>/posts/rss-1</link><description><![CDATA[<p>RSS <b>body</b></p>]]></description>
<pubDate>Wed, 22 Jul 2026 10:00:00 GMT</pubDate></item></channel></rss>`,
    [
      {
        content: "<p>RSS <b>body</b></p>",
        title: "RSS item",
        url: "https://1.1.1.1/posts/rss-1",
      },
    ],
  ],
  [
    "Atom",
    "application/atom+xml",
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>Feed</title><id>urn:feed</id><updated>${published}</updated>
<entry><id>urn:atom-1</id><title>Atom entry</title>
<link rel="alternate" href="https://1.1.1.1/atom-1"/><updated>${published}</updated>
<content type="html">&lt;p&gt;Atom body&lt;/p&gt;</content></entry></feed>`,
    [
      {
        content: "<p>Atom body</p>",
        title: "Atom entry",
        url: "https://1.1.1.1/atom-1",
      },
    ],
  ],
  [
    "JSON Feed",
    "application/feed+json",
    JSON.stringify({
      items: [
        {
          content_html: "<p>JSON body</p>",
          date_published: published,
          id: "json-1",
          title: "JSON item",
          url: "https://1.1.1.1/json-1",
        },
      ],
      title: "Feed",
      version: "https://jsonfeed.org/version/1.1",
    }),
    [
      {
        content: "<p>JSON body</p>",
        title: "JSON item",
        url: "https://1.1.1.1/json-1",
      },
    ],
  ],
  [
    "microformats",
    "text/html",
    `<!doctype html><html><body><div class="h-feed"><h1 class="p-name">Blog</h1>
<article class="h-entry"><h2 class="p-name"><a class="u-url" href="/post-1">Microformat post</a></h2>
<time class="dt-published" datetime="${published}"></time>
<div class="e-content"><p>Microformat body</p></div></article></div></body></html>`,
    [
      {
        content: "<p>Microformat body</p>",
        title: "Microformat post",
        url: "https://1.1.1.1/post-1",
      },
    ],
  ],
  [
    // An expired alert and a Test alert are not news; only the live one lands.
    "CAP",
    "application/atom+xml",
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"
xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"><title>Alerts</title><id>urn:alerts</id>
<updated>${published}</updated>
${[
  ["live", "Actual", future],
  ["expired", "Actual", "2000-01-01T00:00:00Z"],
  ["drill", "Test", future],
]
  .map(
    ([
      id,
      status,
      expires,
    ]) => `<entry><id>urn:${id}</id><title>${id} alert</title>
<link rel="alternate" href="https://1.1.1.1/${id}"/><updated>${published}</updated>
<summary>Flooding</summary><cap:event>Flood Warning</cap:event><cap:status>${status}</cap:status>
<cap:expires>${expires}</cap:expires></entry>`,
  )
  .join("")}</feed>`,
    [
      {
        content: expect.stringContaining(
          "<dt>Event</dt><dd>Flood Warning</dd>",
        ),
        title: "live alert",
        url: "https://1.1.1.1/live",
      },
    ],
  ],
])(
  "a %s feed is fetched, stored and listed for its subscriber",
  async (_kind, contentType, body, expected) => {
    const { cookie, sourceId } = await subscribed(feedUrl);

    await feedParserServing(body, contentType).parseSource({
      id: sourceId,
      url: feedUrl,
    });

    expect(await readerSees(cookie, sourceId)).toEqual(expected);
    const [source] = await client<{ failures: number; success: boolean }[]>`
      SELECT recent_failures AS failures, last_success IS NOT NULL AS success
      FROM sources WHERE id = ${sourceId}`;
    expect(source).toEqual({ failures: 0, success: true });
  },
);

test("a newsletter is stored and listed for its subscriber", async () => {
  const address = "letters@in.example.test";
  const { cookie, sourceId } = await subscribed(address, "email");

  await new EmailHandler(sourcesDataService, articleImporter).processEmail(
    Buffer.from(
      [
        "Subject: Weekly letter",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Letter body</p>",
      ].join("\r\n"),
    ),
    { from: "editor@example.test", to: address },
  );

  const [article] = await readerSees(cookie, sourceId);
  expect(article?.title).toBe("Weekly letter");
  expect(article?.content).toBe("<p>Letter body</p>");
});

// The worker acknowledges every job (BullMQ keeps no failure state), so a
// failed fetch or parse is recorded on the source row or it is lost.
test.each([
  ["a server error", "<html>down</html>", "text/html", 500],
  ["a body that is no feed", "not a feed at all", "text/plain", 200],
])(
  "%s resolves and is recorded on the source in PostgreSQL",
  async (_case, body, contentType, status) => {
    const { cookie, sourceId } = await subscribed(feedUrl);

    await feedParserServing(body, contentType, status).parseSource({
      id: sourceId,
      url: feedUrl,
    });

    const [source] = await client<
      { details: string; failures: number; success: boolean }[]
    >`
      SELECT recent_failures AS failures, recent_failure_details AS details,
        last_success IS NOT NULL AS success
      FROM sources WHERE id = ${sourceId}`;
    expect(source?.failures).toBe(1);
    expect(source?.success).toBe(false);
    expect(source?.details).not.toBe("");
    expect(await readerSees(cookie, sourceId)).toEqual([]);
  },
);

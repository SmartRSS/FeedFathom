import { Elysia } from "elysia";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { RedisClient, SQL } from "bun";
import { fileURLToPath } from "node:url";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import type { AppConfig } from "#platform/config.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { invalidRequestMessage } from "#platform/http/json.ts";
import { UsersDataService } from "#features/auth/user-data-service.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { ArticleImporter } from "#features/feeds/article-import.ts";
import { OutboundFetchBudget } from "#features/feeds/outbound-fetch-budget.ts";
import { RetentionService } from "#features/feeds/retention.ts";
import { postNewsletterAddressHandler } from "#features/feeds/routes/newsletter-address.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import {
  EmailHandler,
  MailRejectedError,
} from "#features/mail-ingest/email-handler.ts";
import {
  createFeedRoutes,
  type FeedRouteServices,
} from "#features/feeds/routes.ts";
import {
  createReaderRoutes,
  type ReaderRouteServices,
} from "#features/reader/routes.ts";
import { migrateDatabase } from "../../../migrator.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);
const mailDomain = "mail.example.test";
const address = `0123456789abcdef@${mailDomain}`;

const databaseUrl = requireDisposableDatabaseUrl();
const client = new SQL(databaseUrl);
const drizzleConnection = createDrizzleConnection(databaseUrl);
const redis = new RedisClient(requireDisposableRedisUrl());
const articlesDataService = new ArticlesDataService(drizzleConnection);
const sourcesDataService = new SourcesDataService(drizzleConnection);
const userSourcesDataService = new UserSourcesDataService(
  drizzleConnection,
  sourcesDataService,
);
const usersDataService = new UsersDataService(drizzleConnection);
const outboundFetchBudget = new OutboundFetchBudget(redis);
const articleImporter = new ArticleImporter(
  articlesDataService,
  userSourcesDataService,
  { publish() {} },
  sourcesDataService,
);
const emailHandler = new EmailHandler(sourcesDataService, articleImporter);
const config = strictFake<AppConfig>(
  {
    FEED_FATHOM_DOMAIN: "localhost:3456",
    MAIL_DOMAIN: mailDomain,
    MAIL_ENABLED: true,
    mailDomain,
    publicOrigin: new URL("http://localhost:3456"),
  },
  "config",
);
const services = strictFake<FeedRouteServices & ReaderRouteServices>(
  {
    articleEventHub: strictFake({}, "articleEventHub"),
    articlesDataService,
    config,
    feedPreviewCache: strictFake({}, "feedPreviewCache"),
    feedRequests: strictFake({}, "feedRequests"),
    foldersDataService: strictFake({}, "foldersDataService"),
    httpClient: strictFake({}, "httpClient"),
    outboundFetchBudget,
    sourceEnqueuer: strictFake({}, "sourceEnqueuer"),
    sourcesDataService,
    userSourcesDataService,
    usersDataService,
    websubStateService: strictFake({}, "websubStateService"),
  },
  "routeServices",
);
const feedRoutes = new Elysia()
  .use(createReaderRoutes(services))
  .use(createFeedRoutes(services));

afterAll(async () => {
  redis.close();
  await drizzleConnection.$client.close();
  await client.close();
});

let account: { cookie: string; id: number };
let other: { cookie: string; id: number };

const createAccount = async (name: string) => {
  const id = Number(process.hrtime.bigint() % 1_000_000_000n);
  await client`
    INSERT INTO users (id, email, name, password, status)
    VALUES (${id}, ${`${name}@example.test`}, ${name}, 'x', 'active')`;
  const sid = await usersDataService.createSession(id, "x", "Browser");
  return { cookie: `sid=${sid}`, id };
};

beforeEach(async () => {
  await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
  await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
  await client`CREATE SCHEMA "public"`;
  await migrateDatabase(databaseUrl, migrationsFolder);
  account = await createAccount("reader");
  other = await createAccount("other");
});

const post = (path: string, body: object, as = account) =>
  feedRoutes.handle(
    new Request(`http://localhost/api${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie: as.cookie },
      method: "POST",
    }),
  );

const subscribe = (url: string, as = account) =>
  post(
    "/subscribe",
    { sourceFolder: null, sourceName: "Letters", sourceUrl: url },
    as,
  );

const listedTitles = async (sourceId: number, as = account) => {
  const listed: { title: string }[] = await (
    await post("/articles", { sources: [sourceId] }, as)
  ).json();
  return listed.map(({ title }) => title);
};

const subscribers = async (sourceId: number) =>
  (
    await client<{ userId: number }[]>`
      SELECT user_id AS "userId" FROM user_sources
      WHERE source_id = ${sourceId} ORDER BY user_id`
  ).map(({ userId }) => userId);

const deliver = (to: string, subject: string) =>
  emailHandler.processEmail(
    Buffer.from(
      [
        `Subject: ${subject}`,
        "Content-Type: text/html; charset=utf-8",
        "",
        `<p>${subject}</p>`,
      ].join("\r\n"),
    ),
    { from: "editor@example.test", to },
  );

const sourceRows = async () => [
  ...(await client<{ id: number; kind: string; url: string }[]>`
    SELECT id, kind, url FROM sources ORDER BY id`),
];

const articleTitles = async (sourceId: number) =>
  (
    await client<{ title: string }[]>`
      SELECT title FROM articles WHERE source_id = ${sourceId} ORDER BY id`
  ).map(({ title }) => title);

const prune = (USER_EXPIRY_DAYS: number) =>
  new RetentionService(drizzleConnection, userSourcesDataService, {
    ARTICLE_STALE_AFTER_DAYS: 0,
    USER_DORMANT_AFTER_DAYS: 0,
    USER_EXPIRY_DAYS,
  }).prune();
const cleanup = () => prune(0);

test("mail to a minted address is kept before Subscribe and read after it", async () => {
  const reserved = await post("/newsletter-address", {
    address: address.toUpperCase(),
  });
  expect(reserved.status).toBe(200);
  expect((await post("/newsletter-address", { address })).status).toBe(200);
  const [source] = await sourceRows();
  expect(await sourceRows()).toEqual([
    { id: source!.id, kind: "email", url: address },
  ]);
  expect((await sourcesDataService.findSourceByUrl(address))?.homeUrl).toBe(
    "http://localhost:3456",
  );

  await deliver(address, "Confirm your subscription");
  expect(await articleTitles(source!.id)).toEqual([
    "Confirm your subscription",
  ]);

  const subscribed = await post("/subscribe", {
    sourceFolder: null,
    sourceName: "Letters",
    sourceUrl: address,
  });
  expect(await subscribed.json()).toEqual({ sourceId: source!.id });

  const listed: { title: string }[] = await (
    await post("/articles", { sources: [source!.id] })
  ).json();
  expect(listed.map(({ title }) => title)).toEqual([
    "Confirm your subscription",
  ]);
  const [subscription] = await client<{ unread: number }[]>`
    SELECT unread_count AS unread FROM user_sources WHERE source_id = ${source!.id}`;
  expect(subscription?.unread).toBe(1);

  await cleanup();
  expect(await articleTitles(source!.id)).toEqual([
    "Confirm your subscription",
  ]);
});

test("an unsubscribed reservation keeps its mail for a day, then only the address", async () => {
  const [feed] = await client<{ id: number }[]>`
    INSERT INTO sources (url, home_url) VALUES ('https://feed.example.test/', 'https://feed.example.test')
    RETURNING id`;
  await client`
    INSERT INTO user_sources (user_id, source_id, name)
    VALUES (${account.id}, ${feed!.id}, 'feed')`;
  await post("/newsletter-address", { address });
  await deliver(address, "Confirm your subscription");

  await cleanup();
  expect((await sourceRows()).map(({ url }) => url)).toContain(address);

  await client`UPDATE sources SET created_at = NOW() - INTERVAL '25 hours' WHERE url = ${address}`;
  await cleanup();
  expect((await sourceRows()).map(({ url }) => url)).toEqual([
    "https://feed.example.test/",
    address,
  ]);
  const [{ count } = { count: -1 }] = await client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM articles`;
  expect(count).toBe(0);
});

test("an address its owner unsubscribed from stays the owner's after cleanup", async () => {
  await subscribe(`${crypto.randomUUID()}@${mailDomain}`, other);
  expect((await subscribe(address)).status).toBe(200);
  const source = (await sourceRows()).find(({ url }) => url === address);
  await deliver(address, "Weekly issue");
  await client`UPDATE sources SET created_at = NOW() - INTERVAL '25 hours' WHERE id = ${source!.id}`;
  await userSourcesDataService.removeSourceFromUser(account.id, source!.id);
  await expect(deliver(address, "Sent after leaving")).rejects.toThrow(
    MailRejectedError,
  );

  await cleanup();
  expect(await articleTitles(source!.id)).toEqual([]);
  expect((await subscribe(address, other)).status).toBe(422);
  expect(await subscribers(source!.id)).toEqual([]);

  expect((await subscribe(address)).status).toBe(200);
  await deliver(address, "Welcome back");
  expect(await listedTitles(source!.id)).toEqual(["Welcome back"]);
});

test("an address that never had mail is deleted after the grace", async () => {
  await subscribe(`${crypto.randomUUID()}@${mailDomain}`, other);
  const subscribedOnce = `fedcba9876543210@${mailDomain}`;
  await post("/newsletter-address", { address });
  expect((await subscribe(subscribedOnce)).status).toBe(200);
  const [left] = await client<{ id: number }[]>`
    SELECT id FROM sources WHERE url = ${subscribedOnce}`;
  await userSourcesDataService.removeSourceFromUser(account.id, left!.id);
  await client`UPDATE sources SET created_at = NOW() - INTERVAL '25 hours'`;

  await cleanup();
  const urls = (await sourceRows()).map(({ url }) => url);
  expect(urls).not.toContain(address);
  expect(urls).not.toContain(subscribedOnce);
});

test("a feed's articles from before its first subscription are neither listed nor kept", async () => {
  const [feed] = await client<{ id: number }[]>`
    INSERT INTO sources (url, home_url, created_at)
    VALUES ('https://feed.example.test/', 'https://feed.example.test', NOW() - INTERVAL '3 days')
    RETURNING id`;
  await client`
    INSERT INTO articles (source_id, guid, author, title, url, content, published_at, last_seen_in_feed_at)
    VALUES (${feed!.id}, 'old', 'a', 'Old item', '', 'body', NOW(), NOW() - INTERVAL '2 days')`;
  await userSourcesDataService.addSourceToUser(account.id, {
    homeUrl: "https://feed.example.test",
    name: "feed",
    parentId: null,
    url: "https://feed.example.test/",
  });

  expect(await listedTitles(feed!.id)).toEqual([]);
  await cleanup();
  expect(await articleTitles(feed!.id)).toEqual([]);
});

test("a reserved address belongs to the account that reserved it", async () => {
  await post("/newsletter-address", { address });
  await deliver(address, "Your login link");
  const [source] = await sourceRows();

  expect((await post("/newsletter-address", { address }, other)).status).toBe(
    200,
  );
  const refused = await subscribe(address, other);
  expect(refused.status).toBe(422);
  expect(await refused.json()).toEqual({ error: invalidRequestMessage });
  expect(await subscribers(source!.id)).toEqual([]);

  expect((await subscribe(address)).status).toBe(200);
  expect(await listedTitles(source!.id)).toEqual(["Your login link"]);
  expect((await subscribe(address, other)).status).toBe(422);
  expect(await subscribers(source!.id)).toEqual([account.id]);
});

test("an address created by subscribing belongs to its subscriber", async () => {
  expect((await subscribe(address)).status).toBe(200);
  const [source] = await sourceRows();

  expect((await subscribe(address, other)).status).toBe(422);
  await client`DELETE FROM user_sources WHERE source_id = ${source!.id}`;
  expect((await subscribe(address, other)).status).toBe(422);
  expect(await subscribers(source!.id)).toEqual([]);
});

test("an older address shared by two accounts stays with both of them", async () => {
  const third = await createAccount("third");
  const [legacy] = await client<{ id: number }[]>`
    INSERT INTO sources (url, home_url, kind, reserved_by)
    VALUES (${address}, 'http://localhost', 'email', ${account.id})
    RETURNING id`;
  await client`
    INSERT INTO user_sources (user_id, source_id, name)
    VALUES (${account.id}, ${legacy!.id}, 'Letters'), (${other.id}, ${legacy!.id}, 'Letters')`;

  await deliver(address, "Weekly issue");
  expect(await listedTitles(legacy!.id)).toEqual(["Weekly issue"]);
  expect(await listedTitles(legacy!.id, other)).toEqual(["Weekly issue"]);
  expect((await subscribe(address)).status).toBe(200);
  expect((await subscribe(address, other)).status).toBe(200);
  expect((await subscribe(address, third)).status).toBe(422);

  await userSourcesDataService.removeSourceFromUser(other.id, legacy!.id);
  expect((await subscribe(address, other)).status).toBe(422);
  expect(await subscribers(legacy!.id)).toEqual([account.id]);
});

test("an older shared address passes to its next subscriber when its owner expires", async () => {
  const [legacy] = await client<{ id: number }[]>`
    INSERT INTO sources (url, home_url, kind, reserved_by)
    VALUES (${address}, 'http://localhost', 'email', ${account.id})
    RETURNING id`;
  await client`
    INSERT INTO user_sources (user_id, source_id, name)
    VALUES (${account.id}, ${legacy!.id}, 'Letters'), (${other.id}, ${legacy!.id}, 'Letters')`;
  const owned = `fedcba9876543210@${mailDomain}`;
  expect((await subscribe(owned)).status).toBe(200);
  await deliver(owned, "Weekly issue");
  await client`UPDATE sources SET created_at = NOW() - INTERVAL '25 hours' WHERE url = ${owned}`;
  await client`UPDATE users SET last_seen_at = NOW() - INTERVAL '10 days' WHERE id = ${account.id}`;

  await prune(5);

  expect((await sourceRows()).map(({ url }) => url)).toEqual([address]);
  expect(await subscribers(legacy!.id)).toEqual([other.id]);
  const [{ owner } = { owner: -1 }] = await client<{ owner: number }[]>`
    SELECT reserved_by AS owner FROM sources WHERE id = ${legacy!.id}`;
  expect(owner).toBe(other.id);
});

test("an older shared address keeps its other subscriber when its owner is deleted", async () => {
  const [legacy] = await client<{ id: number }[]>`
    INSERT INTO sources (url, home_url, kind, reserved_by)
    VALUES (${address}, 'http://localhost', 'email', ${account.id})
    RETURNING id`;
  await client`
    INSERT INTO user_sources (user_id, source_id, name)
    VALUES (${account.id}, ${legacy!.id}, 'Letters'), (${other.id}, ${legacy!.id}, 'Letters')`;
  await deliver(address, "Weekly issue");

  await client`DELETE FROM users WHERE id = ${account.id}`;
  await cleanup();

  expect(await subscribers(legacy!.id)).toEqual([other.id]);
  expect(await listedTitles(legacy!.id, other)).toEqual(["Weekly issue"]);
});

test("an email source without an owner is subscribable only by its subscribers", async () => {
  const [legacy] = await client<{ id: number }[]>`
    INSERT INTO sources (url, home_url, kind)
    VALUES (${address}, 'http://localhost', 'email')
    RETURNING id`;
  await client`
    INSERT INTO user_sources (user_id, source_id, name)
    VALUES (${account.id}, ${legacy!.id}, 'Letters')`;

  expect((await subscribe(address, other)).status).toBe(422);
  expect((await subscribe(address)).status).toBe(200);
  expect(await subscribers(legacy!.id)).toEqual([account.id]);
});

test("a source the cleanup deletes mid-subscribe is created afresh", async () => {
  let vanish = true;
  const racing = new UserSourcesDataService(
    drizzleConnection,
    new (class extends SourcesDataService {
      override async addSource(
        payload: Parameters<SourcesDataService["addSource"]>[0],
      ) {
        const source = await super.addSource(payload);
        if (vanish) await client`DELETE FROM sources WHERE id = ${source.id}`;
        vanish = false;
        return source;
      }
    })(drizzleConnection),
  );

  const subscription = await racing.addSourceToUser(account.id, {
    homeUrl: "https://feed.example.test",
    name: "feed",
    parentId: null,
    url: "https://feed.example.test/",
  });

  const [source] = await sourceRows();
  expect(subscription).toMatchObject({ source: { id: source!.id } });
  expect(await subscribers(source!.id)).toEqual([account.id]);
});

test.each([
  ["another domain", "0123456789abcdef@other.example.test"],
  ["a chosen local part", `postmaster@${mailDomain}`],
])("refuses to reserve %s", async (_case, refused) => {
  const response = await post("/newsletter-address", { address: refused });

  expect(response.status).toBe(400);
  expect(await sourceRows()).toEqual([]);
});

test.each([
  ["a domain-validation mailbox", `postmaster@${mailDomain}`],
  ["another domain", `${crypto.randomUUID()}@other.example.test`],
])("subscribe refuses to create %s", async (_case, refused) => {
  expect((await subscribe(refused)).status).toBe(422);
  expect(await sourceRows()).toEqual([]);
});

test("an existing address subscribe would not create stays subscribable by its owner", async () => {
  const chosen = `editor@${mailDomain}`;
  const [source] = await client<{ id: number }[]>`
    INSERT INTO sources (url, home_url, kind, reserved_by)
    VALUES (${chosen}, 'http://localhost', 'email', ${account.id})
    RETURNING id`;

  expect(await (await subscribe(chosen)).json()).toEqual({
    sourceId: source!.id,
  });
  expect((await subscribe(chosen, other)).status).toBe(422);
});

test("refuses to reserve while mail is disabled", async () => {
  const response = await postNewsletterAddressHandler(
    {
      body: { address },
      request: new Request("http://localhost/api/newsletter-address"),
      user: { id: account.id },
    },
    {
      config: strictFake<AppConfig>(
        { MAIL_ENABLED: false, mailDomain: undefined },
        "config",
      ),
      outboundFetchBudget,
      sourcesDataService,
    },
  );

  expect(response.status).toBe(400);
  expect(await sourceRows()).toEqual([]);
});

test("reserving draws on the per-user outbound budget", async () => {
  for (let call = 0; call < 30; call++) {
    // eslint-disable-next-line no-await-in-loop -- Each call builds on the last.
    await outboundFetchBudget.consume(account.id);
  }

  const outcome = await postNewsletterAddressHandler(
    {
      body: { address },
      request: new Request("http://localhost/api/newsletter-address"),
      user: { id: account.id },
    },
    { config, outboundFetchBudget, sourcesDataService },
  ).catch((caught: unknown) => caught);

  expect(outcome).toBeInstanceOf(HttpDeferredError);
  expect(await sourceRows()).toEqual([]);
});

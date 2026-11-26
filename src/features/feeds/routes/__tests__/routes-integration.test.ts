import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";
import {
  discoverWebSubJobId,
  parseSourceJobId,
  SourceEnqueuer,
} from "#features/feeds/source-enqueue.ts";
import {
  appFor,
  authenticated,
  createDependencies,
  post,
  runLease,
} from "../../../../__tests__/server-harness.ts";

const connection = new Redis(requireDisposableRedisUrl(), {
  maxRetriesPerRequest: null,
});
const queue = new Queue(`routes-test-${crypto.randomUUID()}`, { connection });

const firstId = 1 + Math.floor(Math.random() * 1_000_000_000);
const feedUrls = [
  "https://feed.example/rss",
  "https://truncated.example/rss",
  "https://unstored.example/rss",
];
const newsletterAddress = "newsletter@example.com";
const sourceIds = new Map(
  [...feedUrls, newsletterAddress].map((url, index) => [url, firstId + index]),
);
const idOf = (url: string) => sourceIds.get(url) ?? 0;

const source = (url: string) => ({
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  favicon: null,
  homeUrl: "https://site.example/",
  id: idOf(url),
  kind: "feed" as const,
  lastAttempt: null,
  lastFetchTrigger: null,
  lastSuccess: null,
  recentFailureDetails: "",
  recentFailures: 0,
  reservedBy: null,
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
  url,
  websubCallbackToken: `token-${idOf(url)}`,
  websubHubUrl: "https://hub.example/",
  websubLeaseExpiresAt: null,
  websubSecret: "s3cr3t",
  websubStatus: "verified" as const,
  websubSubscribeAttemptedAt: null,
  websubTopicUrl: url,
});

const cachedPreview = {
  articles: [
    {
      author: "Cached author",
      content: "Cached content",
      enclosures: [],
      guid: "cached-guid",
      publishedAt: new Date("2026-07-19T12:00:00.000Z"),
      title: "Cached article",
      updatedAt: new Date("2026-07-19T12:00:00.000Z"),
      url: "https://site.example/article",
    },
  ],
  description: "Feed description",
  link: "https://site.example/",
  title: "Feed title",
};

const queuedParse = async (url: string) =>
  (await queue.getJob(parseSourceJobId(idOf(url))))?.data ?? null;

const queuedDiscovery = async (url: string) =>
  (await queue.getJob(discoverWebSubJobId(idOf(url))))?.data ?? null;

beforeEach(async () => {
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
});

function serverOnRedis() {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.config.mailDomain = "mail.example";
  dependencies.worker.sourceEnqueuer = new SourceEnqueuer(queue, connection);
  dependencies.worker.feedPreviewCache.get = async (_userId, feedUrl) => {
    if (feedUrl === "https://truncated.example/rss")
      return { ...cachedPreview, feedUrl, truncated: true };
    if (feedUrl === "https://unstored.example/rss")
      return { ...cachedPreview, feedUrl };
    return undefined;
  };
  dependencies.articlesDataService.batchUpsertArticles = async (articles) => {
    if (articles[0]?.sourceId === idOf("https://unstored.example/rss"))
      throw new Error("Database unavailable");
    return articles.length;
  };
  dependencies.userSourcesDataService.recomputeUnreadCounts = async () => {};
  dependencies.userSourcesDataService.addSourceToUser = async (
    _userId,
    { initializationSnapshot = null, url },
  ) => ({
    initializationSnapshot,
    source: source(url),
    subscriptionCreatedAt: new Date(),
    subscriptionId: idOf(url),
  });
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.websubStateService.findSourceByWebSubCallbackToken = async (
    token,
  ) => feedUrls.map(source).find((feed) => feed.websubCallbackToken === token);
  return dependencies;
}

test("a subscription the server cannot fill queues one parse and one WebSub discovery, and a newsletter neither", async () => {
  const app = await appFor(serverOnRedis());

  for (const sourceUrl of [...feedUrls, newsletterAddress]) {
    // eslint-disable-next-line no-await-in-loop -- Each subscription is its own request.
    const response = await post(
      app,
      "/api/subscribe",
      { sourceFolder: null, sourceName: "Feed", sourceUrl },
      { auth: true, origin: "https://reader.example" },
    );
    // eslint-disable-next-line no-await-in-loop -- Each subscription is its own request.
    expect(await response.json()).toEqual({ sourceId: idOf(sourceUrl) });
  }

  for (const sourceUrl of feedUrls) {
    // eslint-disable-next-line no-await-in-loop -- Each source has its own job.
    expect(await queuedParse(sourceUrl)).toEqual({
      id: idOf(sourceUrl),
      skipCache: true,
      trigger: "manual",
    });
  }
  expect(await queuedParse(newsletterAddress)).toBeNull();
  for (const sourceUrl of feedUrls) {
    // eslint-disable-next-line no-await-in-loop -- Each source has its own job.
    expect(await queuedDiscovery(sourceUrl)).toEqual({ id: idOf(sourceUrl) });
  }
  expect(await queuedDiscovery(newsletterAddress)).toBeNull();
  expect(await queue.getJobCountByTypes("waiting")).toBe(2 * feedUrls.length);
});

test.each([
  ["a pushed body that seeds the cache", false, "<rss>updated</rss>", true],
  ["a thin ping", true, "", true],
  ["a pushed body the cache refused", true, "<rss>updated</rss>", false],
])(
  "%s queues a websub-push parse with skipCache %p",
  async (_name, skipCache, body, seedSucceeds) => {
    const dependencies = serverOnRedis();
    dependencies.worker.httpClient.seedCache = async () => {
      if (!seedSucceeds) throw new Error("redis is down");
    };
    const app = await appFor(dependencies);
    const feed = source("https://feed.example/rss");

    const response = await app.handle(
      new Request(
        `http://localhost/api/websub/callback/${feed.websubCallbackToken}`,
        {
          body,
          headers: {
            "content-type": "application/rss+xml",
            "x-hub-signature-256": `sha256=${createHmac("sha256", feed.websubSecret).update(body).digest("hex")}`,
          },
          method: "POST",
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await queuedParse(feed.url)).toEqual({
      id: feed.id,
      skipCache,
      trigger: "websub-push",
    });
    expect(await queue.getJobCountByTypes("waiting")).toBe(1);
  },
);

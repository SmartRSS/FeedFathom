import { FeedParser } from "#features/feeds/feed-parser.ts";
import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import { HttpClient } from "#platform/http/http-client.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { createNativeHttpTransport } from "#platform/http/http-native-transport.ts";
import { HttpDeadlineError } from "#platform/http/request-deadline.ts";
import {
  deserializeFeedPreview,
  serializeFeedPreview,
} from "#features/feeds/feed-preview-cache.ts";
import {
  mapFeedItemToArticle,
  mapFeedToPreview,
  previewArticleLimit,
} from "#features/feeds/feed-mapper.ts";
import type { ServerServices } from "../../../../server-app.ts";
import {
  runLease,
  createDependencies,
  appFor,
  type App,
  get,
  post,
  authenticated,
} from "../../../../__tests__/server-harness.ts";

const subscriptionSource = {
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  favicon: null,
  homeUrl: "https://site.example/",
  id: 91,
  kind: "feed" as const,
  lastAttempt: null,
  lastFetchTrigger: null,
  lastSuccess: null,
  recentFailureDetails: "",
  recentFailures: 0,
  reservedBy: null,
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
  url: "https://feed.example/rss",
  websubCallbackToken: null,
  websubHubUrl: null,
  websubLeaseExpiresAt: null,
  websubSecret: null,
  websubStatus: "none" as const,
  websubSubscribeAttemptedAt: null,
  websubTopicUrl: null,
};

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
  feedUrl: subscriptionSource.url,
  link: subscriptionSource.homeUrl,
  title: "Feed title",
};

const subscribe = (app: App, body: Record<string, unknown>) =>
  post(app, "/api/subscribe", body, {
    auth: true,
    origin: "https://reader.example",
  });

test("rejects invalid subscription policies before cache or database calls", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  let cacheCalls = 0;
  let databaseCalls = 0;
  dependencies.feedPreviewCache.get = async () => {
    cacheCalls++;
    return undefined;
  };
  dependencies.userSourcesDataService.addSourceToUser = async () => {
    databaseCalls++;
    return undefined;
  };
  const app = await appFor(dependencies);

  const invalidTarget = await subscribe(app, {
    sourceFolder: null,
    sourceName: "Invalid",
    sourceUrl: "not a URL or email",
  });
  const invalidFolder = await subscribe(app, {
    sourceFolder: 1.5,
    sourceName: "Invalid",
    sourceUrl: "https://feed.example/rss",
  });
  const blankName = await subscribe(app, {
    sourceFolder: null,
    sourceName: "   ",
    sourceUrl: "https://feed.example/rss",
  });

  expect(invalidTarget.status).toBe(422);
  expect(invalidFolder.status).toBe(422);
  expect(blankName.status).toBe(422);
  expect(cacheCalls).toBe(0);
  expect(databaseCalls).toBe(0);
});

// A refused address, another account's or one subscribe may not create, must
// say no more about it than a malformed target does.
test("answers a refused newsletter address exactly as a malformed target", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.config.MAIL_ENABLED = true;
  dependencies.config.MAIL_DOMAIN = "mail.example";
  dependencies.userSourcesDataService.addSourceToUser = async () => "refused";
  const app = await appFor(dependencies);
  const answer = async (sourceUrl: string) => {
    const response = await subscribe(app, {
      sourceFolder: null,
      sourceName: "Newsletter",
      sourceUrl,
    });
    return { body: await response.text(), status: response.status };
  };

  expect(await answer("postmaster@mail.example")).toEqual(
    await answer("postmaster@"),
  );
});

test("returns sanitized transient preview articles and rejects parser failures", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const cached: Parameters<ServerServices["feedPreviewCache"]["save"]>[] = [];
  dependencies.feedPreviewCache.save = async (...parameters) => {
    cached.push(parameters);
  };
  dependencies.feedParser.preview = async (sourceUrl) =>
    sourceUrl.endsWith("/invalid")
      ? { failure: "Failed to load data for x, received status 404" }
      : {
          articles: [
            {
              author: "Author",
              content:
                '<p onclick="alert(1)">Visible<script>alert(1)</script><a href="javascript:alert(1)">link</a></p>',
              enclosures: [],
              guid: "preview-guid",
              publishedAt: new Date("2024-03-06T12:00:00Z"),
              title: "Article title",
              updatedAt: null,
              url: "https://site.example/article",
            },
            {
              author: "Author",
              content: "<p>Second</p>",
              enclosures: [],
              guid: "preview-guid-2",
              publishedAt: new Date("2024-03-05T12:00:00Z"),
              title: "Second title",
              updatedAt: null,
              url: "https://site.example/second",
            },
          ],
          description: "Feed description",
          feedUrl: sourceUrl,
          link: "https://site.example/",
          title: "Feed title",
        };
  const app = await appFor(dependencies);
  const preview = (sourceUrl: string) =>
    get(app, `/api/preview?feedUrl=${encodeURIComponent(sourceUrl)}`, {
      auth: true,
    });

  const valid = await preview("https://feed.example/rss");
  const invalid = await preview("https://feed.example/invalid");
  const body = await valid.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("title" in body) ||
    !("articles" in body) ||
    !Array.isArray(body.articles)
  )
    throw new Error("Invalid preview response");
  const article = body.articles[0];
  if (
    typeof article !== "object" ||
    article === null ||
    !("title" in article) ||
    !("content" in article) ||
    typeof article.content !== "string"
  )
    throw new Error("Invalid preview article");

  expect(valid.status).toBe(200);
  expect(body.title).toBe("Feed title");
  expect(Reflect.get(body, "truncated")).toBe(false);
  expect(article.title).toBe("Article title");
  expect(body.articles).toHaveLength(2);
  expect(body.articles[1]).toMatchObject({
    content: "<p>Second</p>",
    title: "Second title",
  });
  expect(article.content).toContain("Visible");
  expect(article.content).not.toContain("script");
  expect(article.content).not.toContain("onclick");
  expect(article.content).not.toContain("javascript:");
  expect("guid" in article).toBe(false);
  expect(cached[0]?.[0]).toBe(42);
  expect(cached[0]?.[1]).toBe("https://feed.example/rss");
  expect(cached[0]?.[2].articles[0]?.guid).toBe("preview-guid");
  expect(invalid.status).toBe(400);
  // The sentence is for everyone; the fetcher's own words ride along for
  // an admin's Details.
  expect(await invalid.json()).toEqual({
    detail: expect.stringContaining("received status 404"),
    error: "This feed seems to have moved or been removed.",
  });
});

test("preview and find return a dynamic Retry-After when the host is throttled", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.feedParser.preview = async () => {
    throw new HttpDeferredError(Date.now() + 2_900);
  };
  dependencies.httpClient.get = async () => {
    throw new HttpDeferredError(Date.now() + 5 * 60_000);
  };
  const app = await appFor(dependencies);

  const preview = await get(
    app,
    "/api/preview?feedUrl=https%3A%2F%2Ffeed.example%2Frss",
    { auth: true },
  );
  const find = await get(app, "/api/find?link=https%3A%2F%2Fsite.example%2F", {
    auth: true,
  });

  expect(preview.status).toBe(429);
  expect(preview.headers.get("Retry-After")).toBe("3");
  expect((await preview.json()).error).toContain("3s");

  expect(find.status).toBe(429);
  const findRetryAfter = Number(find.headers.get("Retry-After"));
  expect(findRetryAfter).toBeGreaterThan(290);
  expect(findRetryAfter).toBeLessThanOrEqual(300);
});

// The real budget throws HttpDeferredError once a user is over it. Each of
// the three routes has to ask before anything else, so a spent budget means
// no fetch, no cache read and no database write.
test.each([
  {
    name: "preview",
    request: (app: App) =>
      get(app, "/api/preview?feedUrl=https%3A%2F%2Ffeed.example%2Frss", {
        auth: true,
      }),
  },
  {
    name: "find",
    request: (app: App) =>
      get(app, "/api/find?link=https%3A%2F%2Fsite.example%2F", { auth: true }),
  },
  {
    name: "subscribe",
    request: (app: App) =>
      subscribe(app, {
        sourceFolder: null,
        sourceName: "Feed",
        sourceUrl: "https://feed.example/rss",
      }),
  },
])(
  "$name refuses once the outbound fetch budget is spent",
  async ({ request }) => {
    const dependencies = createDependencies();
    authenticated(dependencies);
    const budgetUsers: number[] = [];
    dependencies.outboundFetchBudget.consume = async (userId) => {
      budgetUsers.push(userId);
      throw new HttpDeferredError(Date.now() + 30_000);
    };
    const reached: string[] = [];
    dependencies.httpClient.get = async () => {
      reached.push("httpClient.get");
      throw new Error("fetched");
    };
    dependencies.feedParser.preview = async () => {
      reached.push("feedParser.preview");
      return { failure: "" };
    };
    dependencies.feedParser.parseUrl = async () => {
      reached.push("feedParser.parseUrl");
      throw new Error("fetched");
    };
    dependencies.feedPreviewCache.get = async () => {
      reached.push("feedPreviewCache.get");
      return undefined;
    };
    dependencies.userSourcesDataService.addSourceToUser = async () => {
      reached.push("addSourceToUser");
      return undefined;
    };
    const app = await appFor(dependencies);

    const response = await request(app);

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(budgetUsers).toEqual([42]);
    expect(reached).toEqual([]);
  },
);

// The discovery fan-out reads only `websub` off a parse, but the real
// parseUrl signature returns the whole parsed feed, so a double has to supply
// it. That asymmetry is the case for giving discovery its own dependency.
type ParsedFeed = Awaited<ReturnType<ServerServices["feedParser"]["parseUrl"]>>;

function parsedFeed(url: string, hubUrl?: string): ParsedFeed {
  return {
    cached: false,
    feed: { description: null, items: [], title: null, url },
    finalUrl: url,
    freshUntil: null,
    websub: hubUrl === undefined ? undefined : { hubUrl, topicUrl: url },
  };
}

test.each([
  {
    feedUrl: "https://site.example/news/feed.xml",
    finalUrl: "https://site.example/news/",
    html: '<html><head><link type="application/rss+xml" title="News" href="feed.xml"></head></html>',
    name: "a path redirect",
    requestedUrl: "https://site.example/old/",
    title: "News",
  },
  {
    feedUrl: "https://site.example/news/feed.xml",
    finalUrl: "https://site.example/news/",
    html: '<html><head><link type="application/rss+xml" title="News" href="feed.xml"></head></html>',
    name: "a host redirect",
    requestedUrl: "https://old.example/news/",
    title: "News",
  },
  {
    feedUrl: "https://site.example/news/feeds/feed.xml",
    finalUrl: "https://site.example/news/latest/",
    html: '<html><head><base href="../feeds/"><link type="application/rss+xml" title="News" href="feed.xml"></head></html>',
    name: "a relative base after a redirect",
    requestedUrl: "https://old.example/archive/",
    title: "News",
  },
  {
    feedUrl: "https://site.example/news/",
    finalUrl: "https://site.example/news/",
    html: '<html><head><base href="../assets/"></head><body><article class="h-entry">News</article></body></html>',
    name: "a microformats page after a redirect",
    requestedUrl: "https://old.example/archive/",
    title: "This page (h-entry)",
  },
  {
    feedUrl: "https://site.example/news/feed.xml",
    finalUrl: "https://site.example/news/feed.xml",
    html: '<rss version="2.0"><channel><title>News</title></channel></rss>',
    name: "an XML feed after a redirect",
    requestedUrl: "https://old.example/feed",
    title: "This feed",
  },
  {
    feedUrl: "https://site.example/news/feed.xml",
    finalUrl: "https://site.example/news/",
    html: '<html><head><link type="application/rss+xml" title="News" href="feed.xml"></head></html>',
    name: "no redirect",
    requestedUrl: "https://site.example/news/",
    title: "News",
  },
])(
  "find resolves candidates using the response URL with $name",
  async ({ requestedUrl, finalUrl, html, title, feedUrl }) => {
    const dependencies = createDependencies();
    authenticated(dependencies);
    const fetched: string[] = [];
    const probed: string[] = [];
    dependencies.httpClient.get = async (url) => {
      fetched.push(url);
      return { data: html, url: finalUrl };
    };
    dependencies.feedParser.parseUrl = async (url) => {
      probed.push(url);
      return parsedFeed(url, "https://hub.example/");
    };
    const app = await appFor(dependencies);

    const response = await get(
      app,
      `/api/find?link=${encodeURIComponent(requestedUrl)}`,
      { auth: true },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { title, url: feedUrl, websub: true },
    ]);
    expect(fetched).toEqual([requestedUrl]);
    expect(probed).toEqual([feedUrl]);
  },
);

test("find marks push feeds and preserves plain or failed candidates", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.httpClient.get = async (url) => ({
    data: `<html><head>
      <link rel="alternate" type="application/rss+xml" title="Push" href="https://site.example/push.xml">
      <link rel="alternate" type="application/rss+xml" title="Plain" href="https://site.example/plain.xml">
      <link rel="alternate" type="application/rss+xml" title="Dead" href="https://site.example/dead.xml">
    </head></html>`,
    url,
  });
  dependencies.feedParser.parseUrl = async (url: string) => {
    if (url.includes("dead")) throw new Error("404");
    return parsedFeed(
      url,
      url.includes("push") ? "https://hub.example/" : undefined,
    );
  };
  const app = await appFor(dependencies);

  const response = await get(
    app,
    "/api/find?link=https%3A%2F%2Fsite.example%2F",
    { auth: true },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    { title: "Push", url: "https://site.example/push.xml", websub: true },
    { title: "Plain", url: "https://site.example/plain.xml", websub: false },
    { title: "Dead", url: "https://site.example/dead.xml", websub: false },
  ]);
});

// scanHtml never returns an empty list -- it appends an OpenRSS suggestion
// when a page advertises nothing -- so a page with no feeds still produces one
// candidate, and find's own `if (!feeds.length)` 400 is unreachable today.
test("find falls back to an OpenRSS suggestion for a page with no feeds", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.httpClient.get = async (url) => ({
    data: "<html><head></head><body>nothing here</body></html>",
    url,
  });
  dependencies.feedParser.parseUrl = async (url: string) => parsedFeed(url);
  const app = await appFor(dependencies);

  const response = await get(
    app,
    "/api/find?link=https%3A%2F%2Fsite.example%2F",
    { auth: true },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    {
      title: "Attempt to use OpenRSS",
      url: "https://openrss.org/site.example/",
      websub: false,
    },
  ]);
});

// The routes above fake the HTTP client, so they cannot show that a user's
// URL is held to the client's private-network guard. Here the client is real
// and only DNS is stubbed: a public-looking host that resolves privately.
const privatelyResolvingClient = (dispatched: string[]) =>
  new HttpClient(createFakeHttpRedis(), {
    transport: createNativeHttpTransport({
      async dispatch(request) {
        dispatched.push(request.url);
        throw new Error("dispatched");
      },
      async lookup() {
        return [{ address: "10.0.0.1", family: 4 }];
      },
    }),
  });

test("find refuses a URL that resolves to a private address", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const dispatched: string[] = [];
  dependencies.httpClient = privatelyResolvingClient(dispatched);
  const app = await appFor(dependencies);

  const response = await get(
    app,
    "/api/find?link=https%3A%2F%2Fintranet.example%2F",
    { auth: true },
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Invalid feed url" });
  expect(dispatched).toEqual([]);
});

test("preview refuses a feed that resolves to a private address", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const dispatched: string[] = [];
  dependencies.redirectMap.resolveUrl = async (url) => url;
  dependencies.feedParser = new FeedParser(
    dependencies.articleImporter,
    privatelyResolvingClient(dispatched),
    dependencies.sourcesDataService,
    dependencies.websubStateService,
    dependencies.redirectMap,
  );
  const app = await appFor(dependencies);

  const response = await get(
    app,
    "/api/preview?feedUrl=https%3A%2F%2Fintranet.example%2Frss",
    { auth: true },
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    detail: expect.any(String),
    error: "This address doesn't serve a feed.",
  });
  expect(dispatched).toEqual([]);
});

// The deferred mapping is about to move from these handlers into the central
// error hook in server-app.ts. What must not move with it is find's fallback:
// it turns any other failure to fetch a user-supplied URL into a 400, and
// deleting that along with the deferred branch would quietly promote a class
// of client errors to 500s.
test("find still answers 400 when fetching a user-supplied url simply fails", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.httpClient.get = async () => {
    throw new Error("getaddrinfo ENOTFOUND site.example");
  };
  const app = await appFor(dependencies);

  const response = await get(
    app,
    "/api/find?link=https%3A%2F%2Fsite.example%2F",
    { auth: true },
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Invalid feed url" });
});

// preview, unlike find, re-raises anything that is not deferred rather than
// classifying it. That reaches the central handler and is a 500 today; moving
// the deferred branch out must not change it.
test("preview surfaces a non-deferred parser failure as a 500", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.feedParser.preview = async () => {
    throw new Error("parser exploded");
  };
  const app = await appFor(dependencies);

  const response = await get(
    app,
    "/api/preview?feedUrl=https%3A%2F%2Ffeed.example%2Frss",
    { auth: true },
  );

  expect(response.status).toBe(500);
});

// Our own request deadline running out is an upstream timeout, not the
// user's URL being wrong. find used to collapse it into "Invalid feed url".
test("find reports our own expired deadline as a 504, not a bad url", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.httpClient.get = async () => {
    throw new HttpDeadlineError(30_000);
  };
  const app = await appFor(dependencies);

  const response = await get(
    app,
    "/api/find?link=https%3A%2F%2Fsite.example%2F",
    { auth: true },
  );

  expect(response.status).toBe(504);
});

test("persists a cached preview inline and recomputes unread counts, without reparsing or trusting browser articles", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const subscriptionCreatedAt = new Date("2026-07-20T12:00:00.000Z");
  const additions: Parameters<
    ServerServices["userSourcesDataService"]["addSourceToUser"]
  >[] = [];
  const upserts: Parameters<
    ServerServices["articlesDataService"]["batchUpsertArticles"]
  >[0][] = [];
  const recomputes: Parameters<
    ServerServices["userSourcesDataService"]["recomputeUnreadCounts"]
  >[0][] = [];
  const successes: Parameters<
    ServerServices["sourcesDataService"]["successSource"]
  >[] = [];
  const enqueues: Parameters<
    ServerServices["sourceEnqueuer"]["enqueueSource"]
  >[0][] = [];
  let parserCalls = 0;

  dependencies.feedParser.preview = async () => {
    parserCalls++;
    return { failure: "" };
  };
  dependencies.feedPreviewCache.get = async () => cachedPreview;
  dependencies.userSourcesDataService.addSourceToUser = async (
    ...parameters
  ) => {
    additions.push(parameters);
    return {
      initializationSnapshot: parameters[1].initializationSnapshot ?? null,
      source: subscriptionSource,
      subscriptionCreatedAt,
      subscriptionId: 1,
    };
  };
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.articlesDataService.batchUpsertArticles = async (articles) => {
    upserts.push(articles);
    return articles.length;
  };
  dependencies.userSourcesDataService.recomputeUnreadCounts = async (
    sourceIds,
  ) => {
    recomputes.push(sourceIds);
  };
  dependencies.sourcesDataService.successSource = async (...parameters) => {
    successes.push(parameters);
  };
  dependencies.sourceEnqueuer.enqueueSource = async (source) => {
    enqueues.push(source);
  };
  const app = await appFor(dependencies);

  const response = await subscribe(app, {
    articles: [{ content: "Forged", guid: "forged-guid" }],
    sourceFolder: null,
    sourceName: "URL feed",
    sourceUrl: subscriptionSource.url,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sourceId: 91 });
  expect(parserCalls).toBe(0);
  expect(additions).toEqual([
    [
      42,
      {
        homeUrl: subscriptionSource.homeUrl,
        initializationSnapshot: serializeFeedPreview(cachedPreview),
        kind: "feed",
        name: "URL feed",
        parentId: null,
        url: subscriptionSource.url,
      },
    ],
  ]);
  expect(upserts).toHaveLength(1);
  const upsertedArticle = upserts[0]?.[0];
  const cachedArticle = cachedPreview.articles[0];
  if (
    !upsertedArticle?.lastSeenInFeedAt ||
    !upsertedArticle.updatedAt ||
    !cachedArticle
  )
    throw new Error("Cached article was not persisted");
  expect(upsertedArticle).toMatchObject({
    author: "Cached author",
    content: "Cached content",
    guid: "cached-guid",
    sourceId: 91,
    title: "Cached article",
  });
  expect(upsertedArticle.lastSeenInFeedAt).toEqual(subscriptionCreatedAt);
  expect(upsertedArticle.updatedAt).toEqual(cachedArticle.publishedAt);
  expect(recomputes).toEqual([[91]]);
  expect(successes).toHaveLength(1);
  // No freshness from the cached fetch, so successSource applies its poll floor.
  expect(successes[0]).toEqual([91, { cached: true, notBefore: undefined }]);
  expect(enqueues).toEqual([]);
});

test("queues a truncated cached preview so the worker imports the whole feed", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const additions: Parameters<
    ServerServices["userSourcesDataService"]["addSourceToUser"]
  >[] = [];
  const enqueues: Parameters<
    ServerServices["sourceEnqueuer"]["enqueueSource"]
  >[0][] = [];
  let upserts = 0;

  dependencies.feedPreviewCache.get = async () => ({
    ...cachedPreview,
    truncated: true,
  });
  dependencies.userSourcesDataService.addSourceToUser = async (
    ...parameters
  ) => {
    additions.push(parameters);
    return {
      initializationSnapshot: parameters[1].initializationSnapshot ?? null,
      source: subscriptionSource,
      subscriptionCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
      subscriptionId: 1,
    };
  };
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.articlesDataService.batchUpsertArticles = async (articles) => {
    upserts++;
    return articles.length;
  };
  dependencies.sourceEnqueuer.enqueueSource = async (source) => {
    enqueues.push(source);
  };
  const app = await appFor(dependencies);

  const response = await subscribe(app, {
    sourceFolder: null,
    sourceName: "URL feed",
    sourceUrl: subscriptionSource.url,
  });

  expect(await response.json()).toEqual({ sourceId: 91 });
  expect(additions[0]?.[1]).toMatchObject({
    homeUrl: subscriptionSource.homeUrl,
    initializationSnapshot: null,
  });
  expect(upserts).toBe(0);
  expect(enqueues).toEqual([subscriptionSource]);
});

test("imports every article of a truncated preview on subscribe without a refetch", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const itemCount = previewArticleLimit + 10;
  const largeFeed = {
    description: null,
    items: Array.from({ length: itemCount }, (_, index) => ({
      authors: [{ name: "Author" }],
      content: `<p>Body ${index}</p>`,
      description: null,
      id: `item-${index}`,
      published: new Date("2026-07-19T12:00:00.000Z"),
      title: `Article ${index}`,
      updated: null,
      url: `https://site.example/${index}`,
    })),
    title: "Big feed",
    url: subscriptionSource.homeUrl,
  };
  // Stands in for Redis: the preview goes through the real wire format.
  let stored: string | undefined;
  let previews = 0;
  const upserts: Parameters<
    ServerServices["articlesDataService"]["batchUpsertArticles"]
  >[0][] = [];
  const enqueues: Parameters<
    ServerServices["sourceEnqueuer"]["enqueueSource"]
  >[0][] = [];

  dependencies.feedParser.preview = async (sourceUrl) => {
    previews++;
    return mapFeedToPreview(largeFeed, sourceUrl);
  };
  dependencies.feedPreviewCache.save = async (_userId, _feedUrl, preview) => {
    stored = serializeFeedPreview(preview);
  };
  dependencies.feedPreviewCache.get = async (_userId, feedUrl) =>
    stored === undefined ? undefined : deserializeFeedPreview(stored, feedUrl);
  dependencies.userSourcesDataService.addSourceToUser = async (
    _userId,
    { initializationSnapshot = null },
  ) => ({
    initializationSnapshot,
    source: subscriptionSource,
    subscriptionCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
    subscriptionId: 1,
  });
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.articlesDataService.batchUpsertArticles = async (articles) => {
    upserts.push(articles);
    return articles.length;
  };
  dependencies.userSourcesDataService.recomputeUnreadCounts = async () => {};
  dependencies.sourcesDataService.successSource = async () => {};
  dependencies.sourceEnqueuer.enqueueSource = async (source) => {
    enqueues.push(source);
  };
  const app = await appFor(dependencies);

  const preview = await get(
    app,
    `/api/preview?feedUrl=${encodeURIComponent(subscriptionSource.url)}`,
    { auth: true },
  );
  const previewBody = await preview.json();
  const response = await subscribe(app, {
    sourceFolder: null,
    sourceName: "URL feed",
    sourceUrl: subscriptionSource.url,
  });

  expect(Reflect.get(previewBody, "articles")).toHaveLength(
    previewArticleLimit,
  );
  expect(Reflect.get(previewBody, "truncated")).toBe(true);
  expect("feed" in previewBody).toBe(false);
  expect(await response.json()).toEqual({ sourceId: 91 });
  expect(previews).toBe(1);
  expect(upserts[0]?.map((article) => article.guid)).toEqual(
    largeFeed.items.map((item) => item.id),
  );
  expect(enqueues).toEqual([]);
});

// A truncated preview's full feed has to resolve its relative links where
// every poll does, against the redirected URL, or the first poll rewrites each
// article's url and content and read articles come back unread.
test("a truncated preview of a redirected feed imports the links a poll stores", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const finalUrl = "https://cdn.example/moved/feed.xml";
  const feed = {
    description: null,
    items: Array.from({ length: previewArticleLimit + 1 }, (_, index) => ({
      authors: [],
      content: `<a href="post-${index}">Body</a>`,
      description: null,
      id: `item-${index}`,
      published: new Date("2026-07-19T12:00:00.000Z"),
      title: `Article ${index}`,
      updated: null,
      url: `post-${index}`,
    })),
    title: "Moved feed",
    url: null,
  };
  let stored: string | undefined;
  const upserts: Parameters<
    ServerServices["articlesDataService"]["batchUpsertArticles"]
  >[0][] = [];
  dependencies.feedParser.preview = async (sourceUrl) =>
    mapFeedToPreview(feed, sourceUrl, { baseUrl: finalUrl });
  dependencies.feedPreviewCache.save = async (_userId, _feedUrl, preview) => {
    stored = serializeFeedPreview(preview);
  };
  dependencies.feedPreviewCache.get = async (_userId, feedUrl) =>
    stored === undefined ? undefined : deserializeFeedPreview(stored, feedUrl);
  dependencies.userSourcesDataService.addSourceToUser = async (
    _userId,
    { initializationSnapshot = null },
  ) => ({
    initializationSnapshot,
    source: subscriptionSource,
    subscriptionCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
    subscriptionId: 1,
  });
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.articlesDataService.batchUpsertArticles = async (articles) => {
    upserts.push(articles);
    return articles.length;
  };
  dependencies.userSourcesDataService.recomputeUnreadCounts = async () => {};
  dependencies.sourcesDataService.successSource = async () => {};
  const app = await appFor(dependencies);

  await get(
    app,
    `/api/preview?feedUrl=${encodeURIComponent(subscriptionSource.url)}`,
    { auth: true },
  );
  await subscribe(app, {
    sourceFolder: null,
    sourceName: "URL feed",
    sourceUrl: subscriptionSource.url,
  });

  const polled = mapFeedItemToArticle(
    feed.items[0]!,
    feed,
    subscriptionSource,
    {
      baseUrl: finalUrl,
    },
  );
  expect(polled.url).toBe("https://cdn.example/moved/post-0");
  expect(upserts[0]?.[0]).toMatchObject({
    content: polled.content,
    url: polled.url,
  });
});

const previewedAt = Date.parse("2020-01-01T00:00:00Z");

const alertFeed = {
  description: null,
  items: [
    {
      authors: [],
      cap: {
        areaDesc: "",
        certainty: "",
        event: "Wind",
        // Current when previewed, long gone by the time this test runs.
        expires: "2020-01-01T00:05:00Z",
        msgType: "",
        onset: "",
        severity: "",
        status: "Actual",
        urgency: "",
      },
      content: null,
      description: null,
      id: "alert-1",
      published: new Date(previewedAt),
      title: "Wind",
      updated: null,
      url: null,
    },
  ],
  title: "Alerts",
  url: subscriptionSource.homeUrl,
};

test("subscribing from a cached CAP preview drops alerts expired since", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  let stored: string | undefined;
  const upserts: Parameters<
    ServerServices["articlesDataService"]["batchUpsertArticles"]
  >[0][] = [];

  dependencies.feedParser.preview = async (sourceUrl) =>
    mapFeedToPreview(alertFeed, sourceUrl, { now: previewedAt });
  dependencies.feedPreviewCache.save = async (_userId, _feedUrl, preview) => {
    stored = serializeFeedPreview(preview);
  };
  dependencies.feedPreviewCache.get = async (_userId, feedUrl) =>
    stored === undefined ? undefined : deserializeFeedPreview(stored, feedUrl);
  dependencies.userSourcesDataService.addSourceToUser = async (
    _userId,
    { initializationSnapshot = null },
  ) => ({
    initializationSnapshot,
    source: subscriptionSource,
    subscriptionCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
    subscriptionId: 1,
  });
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.articlesDataService.batchUpsertArticles = async (articles) => {
    upserts.push(articles);
    return articles.length;
  };
  dependencies.userSourcesDataService.recomputeUnreadCounts = async () => {};
  dependencies.sourcesDataService.successSource = async () => {};
  const app = await appFor(dependencies);

  const preview = await get(
    app,
    `/api/preview?feedUrl=${encodeURIComponent(subscriptionSource.url)}`,
    { auth: true },
  );
  expect(Reflect.get(await preview.json(), "articles")).toHaveLength(1);
  await subscribe(app, {
    sourceFolder: null,
    sourceName: "URL feed",
    sourceUrl: subscriptionSource.url,
  });

  expect(upserts.flat()).toEqual([]);
});

test("a retried subscription skips snapshot alerts that expired between attempts", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const upserts: Parameters<
    ServerServices["articlesDataService"]["batchUpsertArticles"]
  >[0][] = [];
  const snapshot = mapFeedToPreview(alertFeed, subscriptionSource.url, {
    now: previewedAt,
  });

  dependencies.userSourcesDataService.addSourceToUser = async () => ({
    initializationSnapshot: serializeFeedPreview(snapshot),
    source: subscriptionSource,
    subscriptionCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
    subscriptionId: 1,
  });
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.articlesDataService.batchUpsertArticles = async (articles) => {
    upserts.push(articles);
    return articles.length;
  };
  dependencies.userSourcesDataService.recomputeUnreadCounts = async () => {};
  dependencies.sourcesDataService.successSource = async () => {};
  const app = await appFor(dependencies);

  await subscribe(app, {
    sourceFolder: null,
    sourceName: "URL feed",
    sourceUrl: subscriptionSource.url,
  });

  expect(snapshot.articles).toHaveLength(1);
  expect(upserts.flat()).toEqual([]);
});

test("falls back to queueing when inline persistence fails", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const enqueues: Parameters<
    ServerServices["sourceEnqueuer"]["enqueueSource"]
  >[0][] = [];

  dependencies.feedPreviewCache.get = async () => cachedPreview;
  dependencies.userSourcesDataService.addSourceToUser = async (
    _userId,
    { initializationSnapshot = null },
  ) => ({
    initializationSnapshot,
    source: subscriptionSource,
    subscriptionCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
    subscriptionId: 1,
  });
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.articlesDataService.batchUpsertArticles = async () => {
    throw new Error("Database unavailable");
  };
  dependencies.sourceEnqueuer.enqueueSource = async (source) => {
    enqueues.push(source);
  };
  const app = await appFor(dependencies);

  const response = await subscribe(app, {
    sourceFolder: null,
    sourceName: "URL feed",
    sourceUrl: subscriptionSource.url,
  });

  expect(await response.json()).toEqual({ sourceId: 91 });
  expect(enqueues).toEqual([subscriptionSource]);
});

test("queues URL cache misses and starts WebSub discovery, but never for email subscriptions", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.config.MAIL_ENABLED = true;
  const discoveryCalls: Parameters<FeedParser["discoverAndSubscribeWebSub"]>[] =
    [];
  dependencies.feedParser.discoverAndSubscribeWebSub = async (...args) => {
    discoveryCalls.push(args);
  };
  const additions: Parameters<
    ServerServices["userSourcesDataService"]["addSourceToUser"]
  >[] = [];
  const cacheLookups: [number, string][] = [];
  const enqueues: [number, string][] = [];

  dependencies.feedPreviewCache.get = async (userId, sourceUrl) => {
    cacheLookups.push([userId, sourceUrl]);
    return undefined;
  };
  dependencies.userSourcesDataService.addSourceToUser = async (
    ...parameters
  ) => {
    additions.push(parameters);
    const sourceUrl = parameters[1].url;
    return {
      initializationSnapshot: parameters[1].initializationSnapshot ?? null,
      source: {
        ...subscriptionSource,
        id: sourceUrl.includes("@") ? 92 : 91,
        url: sourceUrl,
      },
      subscriptionCreatedAt: new Date(),
      subscriptionId: sourceUrl.includes("@") ? 2 : 1,
    };
  };
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.sourceEnqueuer.enqueueSource = async (source) => {
    enqueues.push([source.id, source.url]);
  };
  const app = await appFor(dependencies);
  const web = await subscribe(app, {
    sourceFolder: null,
    sourceName: "URL feed",
    sourceUrl: subscriptionSource.url,
  });
  const email = await subscribe(app, {
    sourceFolder: null,
    sourceName: "Newsletter",
    sourceUrl: "newsletter@example.com",
  });

  expect(await web.json()).toEqual({ sourceId: 91 });
  expect(await email.json()).toEqual({ sourceId: 92 });
  expect(cacheLookups).toEqual([[42, subscriptionSource.url]]);
  expect(enqueues).toEqual([[91, subscriptionSource.url]]);
  expect(discoveryCalls).toEqual([
    [91, subscriptionSource.url, subscriptionSource.websubStatus],
  ]);
});

test("refuses an email subscription while mail is disabled, before storing anything", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const app = await appFor(dependencies);

  // addSourceToUser is not arranged: the strict fake throws if it is reached.
  const response = await subscribe(app, {
    sourceFolder: null,
    sourceName: "Newsletter",
    sourceUrl: "newsletter@example.com",
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Email subscriptions are not allowed.",
  });
});

test("responds without waiting for WebSub discovery to settle", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.feedParser.discoverAndSubscribeWebSub = () =>
    new Promise<void>(() => {
      // Never resolves, simulating a hub that never answers -- the
      // response must not wait on it.
    });
  dependencies.userSourcesDataService.addSourceToUser = async (
    _userId,
    { initializationSnapshot = null },
  ) => ({
    initializationSnapshot,
    source: subscriptionSource,
    subscriptionCreatedAt: new Date(),
    subscriptionId: 1,
  });
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.sourceEnqueuer.enqueueSource = async () => {};
  const app = await appFor(dependencies);

  const response = await subscribe(app, {
    sourceFolder: null,
    sourceName: "URL feed",
    sourceUrl: subscriptionSource.url,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sourceId: subscriptionSource.id });
});

test("validates OPML files and checks plain-text content before parsing", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const trees: Parameters<
    ServerServices["opmlImportService"]["insertTree"]
  >[1][] = [];
  dependencies.opmlImportService.insertTree = async (_userId, tree) => {
    trees.push(tree);
  };
  const app = await appFor(dependencies);
  const upload = (file?: File) => {
    const body = new FormData();
    if (file) body.set("opml", file);
    return app.handle(
      new Request("http://localhost/api/options/opml", {
        body,
        headers: { cookie: "sid=test" },
        method: "POST",
      }),
    );
  };

  const valid = await upload(
    new File(["<opml><body /></opml>"], "feeds.opml", { type: "text/xml" }),
  );
  const binary = await upload(
    new File([`<opml>${String.fromCharCode(0)}</opml>`], "feeds.opml", {
      type: "text/xml",
    }),
  );
  const missing = await upload();

  expect(valid.status).toBe(200);
  expect(binary.status).toBe(400);
  expect(missing.status).toBe(422);
  expect(trees).toEqual([[]]);
});

test("exports the subscription tree as OPML, without newsletters", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.foldersDataService.getUserFolders = async () => [
    {
      createdAt: new Date(),
      id: 4,
      name: "News & views",
      updatedAt: new Date(),
      userId: 1,
    },
  ];
  dependencies.userSourcesDataService.getUserSources = async () => [
    {
      faviconFingerprint: null,
      homeUrl: "https://news.test",
      id: 1,
      kind: "feed",
      lastSuccess: null,
      name: "Daily",
      parentId: 4,
      pausedUntil: null,
      recentFailureDetails: "",
      recentFailures: 0,
      unreadArticlesCount: 0,
      url: "https://news.test/feed",
    },
    {
      faviconFingerprint: null,
      homeUrl: null,
      id: 2,
      kind: "email",
      lastSuccess: null,
      name: "A newsletter",
      parentId: null,
      pausedUntil: null,
      recentFailureDetails: "",
      recentFailures: 0,
      unreadArticlesCount: 0,
      url: "abc123@mail.example.com",
    },
  ];
  const app = await appFor(dependencies);

  const anonymous = await get(app, "/api/options/opml");
  const response = await get(app, "/api/options/opml", { auth: true });
  const body = await response.text();

  expect(anonymous.status).toBe(401);
  expect(response.headers.get("content-type")).toBe(
    "text/x-opml; charset=utf-8",
  );
  expect(response.headers.get("content-disposition")).toContain(
    'filename="feedfathom-subscriptions.opml"',
  );
  expect(body).toContain('xmlUrl="https://news.test/feed"');
  expect(body).toContain('text="News &amp; views"');
  // The address is one this instance minted and routes mail for. Anywhere
  // else it is a subscription nothing would ever deliver to.
  expect(body).not.toContain("abc123@mail.example.com");
});

test("exports the same bytes whatever order the services return rows in", async () => {
  const folders = [
    {
      createdAt: new Date(),
      id: 1,
      name: "Zed",
      updatedAt: new Date(),
      userId: 1,
    },
    {
      createdAt: new Date(),
      id: 2,
      name: "Alpha",
      updatedAt: new Date(),
      userId: 1,
    },
  ];
  const sources = [
    {
      faviconFingerprint: null,
      homeUrl: "https://b.test",
      id: 1,
      kind: "feed" as const,
      lastSuccess: null,
      name: "Beta",
      parentId: 2,
      pausedUntil: null,
      recentFailureDetails: "",
      recentFailures: 0,
      unreadArticlesCount: 0,
      url: "https://b.test/feed",
    },
    {
      faviconFingerprint: null,
      homeUrl: "https://a.test",
      id: 2,
      kind: "feed" as const,
      lastSuccess: null,
      name: "Aardvark",
      parentId: 2,
      pausedUntil: null,
      recentFailureDetails: "",
      recentFailures: 0,
      unreadArticlesCount: 0,
      url: "https://a.test/feed",
    },
    {
      faviconFingerprint: null,
      homeUrl: "https://c.test",
      id: 3,
      kind: "feed" as const,
      lastSuccess: null,
      name: "Loose",
      parentId: null,
      pausedUntil: null,
      recentFailureDetails: "",
      recentFailures: 0,
      unreadArticlesCount: 0,
      url: "https://c.test/feed",
    },
  ];
  const exportWith = async (reversed: boolean) => {
    const dependencies = createDependencies();
    authenticated(dependencies);
    dependencies.foldersDataService.getUserFolders = async () =>
      reversed ? folders.toReversed() : folders;
    dependencies.userSourcesDataService.getUserSources = async () =>
      reversed ? sources.toReversed() : sources;
    const app = await appFor(dependencies);
    return await (await get(app, "/api/options/opml", { auth: true })).text();
  };

  const first = await exportWith(false);
  const second = await exportWith(true);

  expect(first).toBe(second);
  expect(first.indexOf("Alpha")).toBeLessThan(first.indexOf("Zed"));
  expect(first.indexOf("Aardvark")).toBeLessThan(first.indexOf("Beta"));
});

const websubSource = {
  ...subscriptionSource,
  websubCallbackToken: "callback-token",
  websubHubUrl: "https://hub.example/",
  websubSecret: "s3cr3t",
  websubStatus: "pending" as const,
  websubTopicUrl: "https://feed.example/rss",
};

test("WebSub callback verification requires no session and echoes the challenge", async () => {
  const dependencies = createDependencies();
  let verifiedId: number | undefined;
  let verifiedLease: Date | undefined;
  dependencies.websubStateService.findSourceByWebSubCallbackToken = async (
    token,
  ) => (token === "callback-token" ? websubSource : undefined);
  dependencies.websubStateService.markWebSubVerified = async (id, lease) => {
    verifiedId = id;
    verifiedLease = lease;
  };
  const app = await appFor(dependencies);
  const before = Date.now();

  const response = await get(
    app,
    `/api/websub/callback/callback-token?${new URLSearchParams({
      "hub.challenge": "abc123",
      "hub.lease_seconds": "600",
      "hub.mode": "subscribe",
      "hub.topic": websubSource.websubTopicUrl,
    })}`,
  );

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("abc123");
  expect(verifiedId).toBe(websubSource.id);
  // hub.lease_seconds is seconds; the lease is stored as an instant.
  expect(verifiedLease?.getTime()).toBeGreaterThanOrEqual(before + 600_000);
  expect(verifiedLease?.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
});

test("WebSub callback verification 404s for an unknown token or mismatched topic", async () => {
  const dependencies = createDependencies();
  dependencies.websubStateService.findSourceByWebSubCallbackToken = async (
    token,
  ) => (token === "callback-token" ? websubSource : undefined);
  const app = await appFor(dependencies);

  const unknownToken = await get(
    app,
    `/api/websub/callback/nope?${new URLSearchParams({
      "hub.challenge": "abc123",
      "hub.mode": "subscribe",
      "hub.topic": websubSource.websubTopicUrl,
    })}`,
  );
  const mismatchedTopic = await get(
    app,
    `/api/websub/callback/callback-token?${new URLSearchParams({
      "hub.challenge": "abc123",
      "hub.mode": "subscribe",
      "hub.topic": "https://someone-else.example/feed",
    })}`,
  );

  expect(unknownToken.status).toBe(404);
  expect(mismatchedTopic.status).toBe(404);
});

// The hub sends the feed document and signs it with the secret we gave that
// hub, so the content is in hand. Re-fetching it to learn what the push
// already said is a request against a resource we hold, and it leaves the
// cached copy holding the document the push replaced.
test("WebSub push requires a valid signature, then seeds the cache and re-parses without a fetch", async () => {
  const dependencies = createDependencies();
  const enqueued: Parameters<
    ServerServices["sourceEnqueuer"]["enqueueSource"]
  >[] = [];
  const seeded: Array<{
    body: string;
    contentType: null | string;
    url: string;
  }> = [];
  dependencies.websubStateService.findSourceByWebSubCallbackToken = async (
    token,
  ) => (token === "callback-token" ? websubSource : undefined);
  dependencies.sourceEnqueuer.enqueueSource = async (...parameters) => {
    enqueued.push(parameters);
  };
  dependencies.httpClient.seedCache = async (url, pushed, headers) => {
    seeded.push({
      body: pushed.toString(),
      contentType: headers.get("content-type"),
      url,
    });
  };
  const app = await appFor(dependencies);
  const body = "<rss>updated</rss>";
  const validSignature = `sha256=${createHmac("sha256", websubSource.websubSecret).update(body).digest("hex")}`;

  const wrongSignature = await app.handle(
    new Request("http://localhost/api/websub/callback/callback-token", {
      body,
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      method: "POST",
    }),
  );
  const validPush = await app.handle(
    new Request("http://localhost/api/websub/callback/callback-token", {
      body,
      headers: {
        "content-type": "application/rss+xml",
        "x-hub-signature-256": validSignature,
      },
      method: "POST",
    }),
  );

  expect(wrongSignature.status).toBe(403);
  expect(validPush.status).toBe(200);
  // Only the verified push reaches the cache.
  expect(seeded).toEqual([
    {
      body,
      contentType: "application/rss+xml",
      url: websubSource.url,
    },
  ]);
  // skipCache false: the seeded body is what the parse is meant to read.
  expect(enqueued).toEqual([
    [{ id: websubSource.id, url: websubSource.url }, "websub-push", false],
  ]);
});

// A thin ping is a notification with no document attached. There is nothing
// to seed, so the parse has to go and get it.
test("WebSub push with no body falls back to a fetch", async () => {
  const dependencies = createDependencies();
  const enqueued: Parameters<
    ServerServices["sourceEnqueuer"]["enqueueSource"]
  >[] = [];
  let seedCalls = 0;
  dependencies.websubStateService.findSourceByWebSubCallbackToken = async (
    token,
  ) => (token === "callback-token" ? websubSource : undefined);
  dependencies.sourceEnqueuer.enqueueSource = async (...parameters) => {
    enqueued.push(parameters);
  };
  dependencies.httpClient.seedCache = async () => {
    seedCalls++;
  };
  const app = await appFor(dependencies);
  const validSignature = `sha256=${createHmac("sha256", websubSource.websubSecret).update("").digest("hex")}`;

  const response = await post(
    app,
    "/api/websub/callback/callback-token",
    undefined,
    { headers: { "x-hub-signature-256": validSignature } },
  );

  expect(response.status).toBe(200);
  expect(seedCalls).toBe(0);
  expect(enqueued).toEqual([
    [{ id: websubSource.id, url: websubSource.url }, "websub-push", true],
  ]);
});

// Losing the saved request is acceptable; losing the notification is not.
test("WebSub push still re-parses when the cache seed fails", async () => {
  const dependencies = createDependencies();
  const enqueued: Parameters<
    ServerServices["sourceEnqueuer"]["enqueueSource"]
  >[] = [];
  dependencies.websubStateService.findSourceByWebSubCallbackToken = async (
    token,
  ) => (token === "callback-token" ? websubSource : undefined);
  dependencies.sourceEnqueuer.enqueueSource = async (...parameters) => {
    enqueued.push(parameters);
  };
  dependencies.httpClient.seedCache = async () => {
    throw new Error("redis is down");
  };
  const app = await appFor(dependencies);
  const body = "<rss>updated</rss>";
  const validSignature = `sha256=${createHmac("sha256", websubSource.websubSecret).update(body).digest("hex")}`;

  const response = await app.handle(
    new Request("http://localhost/api/websub/callback/callback-token", {
      body,
      headers: { "x-hub-signature-256": validSignature },
      method: "POST",
    }),
  );

  expect(response.status).toBe(200);
  expect(enqueued).toEqual([
    [{ id: websubSource.id, url: websubSource.url }, "websub-push", true],
  ]);
});

test("WebSub push over the body cap is rejected without buffering, whatever it claims", async () => {
  const dependencies = createDependencies();
  const enqueued: Parameters<
    ServerServices["sourceEnqueuer"]["enqueueSource"]
  >[] = [];
  const seeded: unknown[] = [];
  dependencies.websubStateService.findSourceByWebSubCallbackToken = async (
    token,
  ) => (token === "callback-token" ? websubSource : undefined);
  dependencies.sourceEnqueuer.enqueueSource = async (...parameters) => {
    enqueued.push(parameters);
  };
  dependencies.httpClient.seedCache = async (_url, pushed) => {
    seeded.push(pushed);
  };
  const app = await appFor(dependencies);
  const oversized = "x".repeat(24 * 1024 * 1024 + 1);
  // A body large enough that no hub push is legitimate, streamed without a
  // declared Content-Length, so the incremental read is what has to stop it.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(oversized));
      controller.close();
    },
  });

  const response = await app.handle(
    new Request("http://localhost/api/websub/callback/callback-token", {
      body,
      // @ts-expect-error -- duplex is required for streaming request bodies
      // but undici's Request type omits it.
      duplex: "half",
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      method: "POST",
    }),
  );

  expect(response.status).toBe(413);
  expect(seeded).toEqual([]);
  expect(enqueued).toEqual([]);
});

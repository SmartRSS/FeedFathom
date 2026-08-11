import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { createServerApp, type ServerDependencies } from "../src/server-app.ts";
import { sessionResponse } from "../src/contracts/responses.ts";
import { serializeFeedPreview } from "../src/lib/feed-preview-cache.ts";
import { HttpDeferredError } from "../src/lib/http-client.ts";

const spaDirectory = resolve(import.meta.dir, "../src/spa");
const mailRelaySecretHeader = "x-feedfathom-mail-secret";
const maxRawEmailBytes = 5 * 1_024 * 1_024;
const unexpected = (name: string): never => {
  throw new Error(`Unexpected dependency call: ${name}`);
};

const runLease: ServerDependencies["userSourcesDataService"]["withSubscriptionInitializationLease"] =
  async (_subscriptionId, work) => ({
    outcome: "claimed",
    result: await work(),
  });

const sessionUser = {
  email: "reader@example.com",
  id: 42,
  isAdmin: false,
  name: "Reader",
  status: "active" as const,
};

const account = {
  activationToken: null,
  activationTokenExpiresAt: null,
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  email: sessionUser.email,
  id: sessionUser.id,
  isAdmin: false,
  lastSeenAt: new Date("2026-07-20T12:00:00.000Z"),
  name: sessionUser.name,
  password: "hashed-password",
  status: "active" as const,
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
};

function createDependencies(): ServerDependencies {
  const appConfig: ServerDependencies["config"] = {
    ALLOWED_EMAILS: [],
    ARTICLE_STALE_AFTER_DAYS: 365,
    CLEANUP_INTERVAL: 1_000,
    DATABASE_URL: "postgres://feedfathom:feedfathom@localhost/feedfathom",
    DB_POOL_MAX: 10,
    ENABLE_REGISTRATION: false,
    GATHER_JOBS_INTERVAL: 1_000,
    LOCK_DURATION: 1_000,
    MAIL_ENABLED: false,
    USER_DORMANT_AFTER_DAYS: 365,
    USER_EXPIRY_DAYS: 730,
    WORKER_CONCURRENCY: 1,
  };

  return {
    articlesDataService: {
      async batchUpsertArticles() {
        return unexpected("articlesDataService.batchUpsertArticles");
      },
      async getUserArticle() {
        return undefined;
      },
      async getUserArticlesForSources() {
        return [];
      },
      async removeUserArticles() {
        return unexpected("articlesDataService.removeUserArticles");
      },
    },
    config: appConfig,
    emailHandler: {
      async processEmail() {
        return unexpected("emailHandler.processEmail");
      },
    },
    feedParser: {
      async discoverAndSubscribeWebSub() {},
      async parseUrl() {
        return unexpected("feedParser.parseUrl");
      },
      async preview() {
        return undefined;
      },
    },
    feedPreviewCache: {
      async get() {
        return undefined;
      },
      async save() {},
    },
    fetcher: async () => Response.json({ success: false }),
    foldersDataService: {
      async createFolder() {
        return unexpected("foldersDataService.createFolder");
      },
      async getUserFolders() {
        return [];
      },
      async removeEmptyUserFolder() {
        return unexpected("foldersDataService.removeEmptyUserFolder");
      },
    },
    httpClient: {
      async get() {
        return { data: "" };
      },
    },
    get mailEnabled() {
      return appConfig.MAIL_ENABLED;
    },
    mailSender: {
      async sendActivationEmail() {},
    },
    opmlImportService: {
      async insertTree() {
        return unexpected("opmlImportService.insertTree");
      },
    },
    opmlParser: {
      parseOpml() {
        return [];
      },
    },
    password: {
      async hash(value) {
        return `hashed:${value}`;
      },
      async verify(value, hash) {
        return hash === `hashed:${value}`;
      },
    },
    redirectMap: {
      async getAllRedirects() {
        return {};
      },
      async removeRedirect() {},
    },
    // TEMPORARY: WebSub push verification, remove after confirming.
    redis: {
      async get() {
        return null;
      },
      async set() {},
    },
    sourcesDataService: {
      async deleteSource() {},
      async enqueueSource() {},
      async findSourceByWebSubCallbackToken() {
        return undefined;
      },
      async getFavicon() {
        return null;
      },
      async listAllSources() {
        return [];
      },
      async markWebSubVerified() {},
      async successSource() {},
      async updateSourceUrl() {},
    },
    usersDataService: {
      async activateUser() {
        return unexpected("usersDataService.activateUser");
      },
      async createSession() {
        return "test-session";
      },
      async deleteSession() {},
      async createUser() {
        return undefined;
      },
      async findUser() {
        return undefined;
      },
      async findUserByActivationToken() {
        return undefined;
      },
      async getUserBySid() {
        return undefined;
      },
      async getUserCount() {
        return 0;
      },
      async touchLastSeen() {},
      async updatePassword() {
        return unexpected("usersDataService.updatePassword");
      },
    },
    userSourcesDataService: {
      async addSourceToUser() {
        return unexpected("userSourcesDataService.addSourceToUser");
      },
      async getUserSources() {
        return [];
      },
      async recomputeUnreadCounts() {
        return unexpected("userSourcesDataService.recomputeUnreadCounts");
      },
      async removeSourceFromUser() {
        return unexpected("userSourcesDataService.removeSourceFromUser");
      },
      async updateUserSource() {
        return unexpected("userSourcesDataService.updateUserSource");
      },
      async withSubscriptionInitializationLease() {
        return unexpected(
          "userSourcesDataService.withSubscriptionInitializationLease",
        );
      },
    },
  };
}

const appFor = (dependencies: ServerDependencies, production = false) =>
  createServerApp(dependencies, { production, spaDirectory });

const authenticated = (dependencies: ServerDependencies) => {
  dependencies.usersDataService.getUserBySid = async () => sessionUser;
};

test("returns a session matching the browser contract", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const app = await appFor(dependencies);

  const response = await app.handle(
    new Request("http://localhost/api/session", {
      headers: { cookie: "sid=test" },
    }),
  );
  const body: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(Value.Check(sessionResponse, body)).toBe(true);
  expect(body).toEqual({ user: sessionUser });
});

test("ends only the current session and clears its cookie", async () => {
  const dependencies = createDependencies();
  const deleted: string[] = [];
  dependencies.usersDataService.deleteSession = async (sid) => {
    deleted.push(sid);
  };
  const app = await appFor(dependencies);

  const response = await app.handle(
    new Request("http://localhost/api/logout", {
      headers: { cookie: "sid=current-session" },
      method: "POST",
    }),
  );
  const withoutCookie = await app.handle(
    new Request("http://localhost/api/logout", { method: "POST" }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(response.headers.get("set-cookie")).toBe(
    "sid=; HttpOnly; Max-Age=0; Path=/; SameSite=Lax",
  );
  expect(withoutCookie.status).toBe(200);
  expect(deleted).toEqual(["current-session"]);
});

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
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
  url: "https://feed.example/rss",
  websubCallbackToken: null,
  websubHubUrl: null,
  websubLeaseExpiresAt: null,
  websubSecret: null,
  websubStatus: "none" as const,
  websubTopicUrl: null,
};

const cachedPreview = {
  articles: [
    {
      author: "Cached author",
      content: "Cached content",
      guid: "cached-guid",
      publishedAt: new Date("2026-07-19T12:00:00.000Z"),
      title: "Cached article",
      url: "https://site.example/article",
    },
  ],
  description: "Feed description",
  feedUrl: subscriptionSource.url,
  link: subscriptionSource.homeUrl,
  title: "Feed title",
};

const subscribe = (
  app: Awaited<ReturnType<typeof createServerApp>>,
  body: Record<string, unknown>,
) =>
  app.handle(
    new Request("https://reader.example/api/subscribe", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        cookie: "sid=test",
      },
      method: "POST",
    }),
  );

test.each([
  ["/settings", "text/html", 200, "text/html"],
  ["/index.html", "text/html", 200, "text/html"],
  ["/api/session", "text/html", 200, "application/json"],
  ["/api/missing", "text/html", 404, null],
  ["/assets/missing", "text/html", 404, null],
  ["/assets/missing.js", "text/html", 404, null],
  ["/settings", "application/json", 404, null],
])("serves %s selectively", async (path, accept, status, contentType) => {
  const app = await appFor(createDependencies(), true);
  const response = await app.handle(
    new Request(`http://localhost${path}`, { headers: { accept } }),
  );

  expect(response.status).toBe(status);
  if (contentType)
    expect(response.headers.get("content-type")).toContain(contentType);
});

test.each([
  "/api/preview?feedUrl=https%3A%2F%2Ffeed.example%2Frss",
  "/api/find?link=https%3A%2F%2Fsite.example%2F",
  "/api/article?article=1",
  "/api/tree",
  "/api/folders",
  "/api/options",
])("rejects unauthenticated access to %s", async (path) => {
  const app = await appFor(createDependencies());
  const response = await app.handle(new Request(`http://localhost${path}`));

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

test("rejects unauthenticated article list requests", async () => {
  const app = await appFor(createDependencies());
  const response = await app.handle(
    new Request("http://localhost/api/articles", {
      body: JSON.stringify({ sources: [3] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

test("normalizes reader inputs and rejects malformed values before dependencies", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const articleQueries: [number[], number][] = [];
  const folders: [number, string][] = [];
  dependencies.articlesDataService.getUserArticlesForSources = async (
    sourceIds,
    userId,
  ) => {
    articleQueries.push([sourceIds, userId]);
    return [];
  };
  dependencies.foldersDataService.createFolder = async (userId, name) => {
    folders.push([userId, name]);
    const now = new Date();
    return { createdAt: now, id: 7, name, updatedAt: now, userId };
  };
  const app = await appFor(dependencies);
  const cookie = { cookie: "sid=test" };

  const articles = await app.handle(
    new Request("http://localhost/api/articles", {
      body: JSON.stringify({ sources: [3, 5] }),
      headers: { ...cookie, "content-type": "application/json" },
      method: "POST",
    }),
  );
  const malformedArticles = await app.handle(
    new Request("http://localhost/api/articles", {
      body: JSON.stringify({ sources: [3, "nope"] }),
      headers: { ...cookie, "content-type": "application/json" },
      method: "POST",
    }),
  );
  const largeSources = Array.from({ length: 501 }, (_, index) => index + 1);
  const largeArticleRequest = await app.handle(
    new Request("http://localhost/api/articles", {
      body: JSON.stringify({ sources: largeSources }),
      headers: { ...cookie, "content-type": "application/json" },
      method: "POST",
    }),
  );
  const folder = await app.handle(
    new Request("http://localhost/api/folders", {
      body: JSON.stringify({ name: "  Reading  " }),
      headers: { ...cookie, "content-type": "application/json" },
      method: "POST",
    }),
  );
  const blankFolder = await app.handle(
    new Request("http://localhost/api/folders", {
      body: JSON.stringify({ name: "   " }),
      headers: { ...cookie, "content-type": "application/json" },
      method: "POST",
    }),
  );

  expect(articles.status).toBe(200);
  expect(malformedArticles.status).toBe(422);
  expect(largeArticleRequest.status).toBe(422);
  expect(folder.status).toBe(200);
  expect(blankFolder.status).toBe(422);
  expect(articleQueries).toEqual([[[3, 5], 42]]);
  expect(folders).toEqual([[42, "Reading"]]);
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

test("returns sanitized transient preview articles and rejects parser failures", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const cached: Parameters<ServerDependencies["feedPreviewCache"]["save"]>[] =
    [];
  dependencies.feedPreviewCache.save = async (...parameters) => {
    cached.push(parameters);
  };
  dependencies.feedParser.preview = async (sourceUrl) =>
    sourceUrl.endsWith("/invalid")
      ? undefined
      : {
          articles: [
            {
              author: "Author",
              content:
                '<p onclick="alert(1)">Visible<script>alert(1)</script><a href="javascript:alert(1)">link</a></p>',
              guid: "preview-guid",
              publishedAt: new Date("2024-03-06T12:00:00Z"),
              title: "Article title",
              url: "https://site.example/article",
            },
          ],
          description: "Feed description",
          feedUrl: sourceUrl,
          link: "https://site.example/",
          title: "Feed title",
        };
  const app = await appFor(dependencies);
  const preview = (sourceUrl: string) =>
    app.handle(
      new Request(
        `http://localhost/api/preview?feedUrl=${encodeURIComponent(sourceUrl)}`,
        { headers: { cookie: "sid=test" } },
      ),
    );

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
  expect(article.title).toBe("Article title");
  expect(article.content).toContain("Visible");
  expect(article.content).not.toContain("script");
  expect(article.content).not.toContain("onclick");
  expect(article.content).not.toContain("javascript:");
  expect("guid" in article).toBe(false);
  expect(cached[0]?.[0]).toBe(42);
  expect(cached[0]?.[1]).toBe("https://feed.example/rss");
  expect(cached[0]?.[2].articles[0]?.guid).toBe("preview-guid");
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "Invalid feed url" });
});

test("preview and find return a dynamic Retry-After when the host is throttled", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.feedParser.preview = async () => {
    throw new HttpDeferredError(Date.now() + 2_500);
  };
  dependencies.httpClient.get = async () => {
    throw new HttpDeferredError(Date.now() + 5 * 60_000);
  };
  const app = await appFor(dependencies);

  const preview = await app.handle(
    new Request(
      "http://localhost/api/preview?feedUrl=https%3A%2F%2Ffeed.example%2Frss",
      { headers: { cookie: "sid=test" } },
    ),
  );
  const find = await app.handle(
    new Request(
      "http://localhost/api/find?link=https%3A%2F%2Fsite.example%2F",
      {
        headers: { cookie: "sid=test" },
      },
    ),
  );

  expect(preview.status).toBe(429);
  expect(preview.headers.get("Retry-After")).toBe("3");
  expect((await preview.json()).error).toContain("3s");

  expect(find.status).toBe(429);
  const findRetryAfter = Number(find.headers.get("Retry-After"));
  expect(findRetryAfter).toBeGreaterThan(290);
  expect(findRetryAfter).toBeLessThanOrEqual(300);
});

test("persists a cached preview inline and recomputes unread counts, without reparsing or trusting browser articles", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const subscriptionCreatedAt = new Date("2026-07-20T12:00:00.000Z");
  const additions: Parameters<
    ServerDependencies["userSourcesDataService"]["addSourceToUser"]
  >[] = [];
  const upserts: Parameters<
    ServerDependencies["articlesDataService"]["batchUpsertArticles"]
  >[0][] = [];
  const recomputes: Parameters<
    ServerDependencies["userSourcesDataService"]["recomputeUnreadCounts"]
  >[0][] = [];
  const successes: Parameters<
    ServerDependencies["sourcesDataService"]["successSource"]
  >[] = [];
  const enqueues: Parameters<
    ServerDependencies["sourcesDataService"]["enqueueSource"]
  >[0][] = [];
  let parserCalls = 0;

  dependencies.feedParser.preview = async () => {
    parserCalls++;
    return undefined;
  };
  dependencies.feedPreviewCache.get = async () => cachedPreview;
  dependencies.userSourcesDataService.addSourceToUser = async (
    ...parameters
  ) => {
    additions.push(parameters);
    return {
      source: subscriptionSource,
      subscriptionCreatedAt,
      subscriptionId: 1,
    };
  };
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.articlesDataService.batchUpsertArticles = async (articles) => {
    upserts.push(articles);
  };
  dependencies.userSourcesDataService.recomputeUnreadCounts = async (
    sourceIds,
  ) => {
    recomputes.push(sourceIds);
  };
  dependencies.sourcesDataService.successSource = async (...parameters) => {
    successes.push(parameters);
  };
  dependencies.sourcesDataService.enqueueSource = async (source) => {
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
  expect(successes[0]?.slice(0, 2)).toEqual([91, true]);
  expect(successes[0]?.[2]).toBeInstanceOf(Date);
  expect(enqueues).toEqual([]);
});

test("falls back to queueing when inline persistence fails", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const enqueues: Parameters<
    ServerDependencies["sourcesDataService"]["enqueueSource"]
  >[0][] = [];

  dependencies.feedPreviewCache.get = async () => cachedPreview;
  dependencies.userSourcesDataService.addSourceToUser = async () => ({
    source: subscriptionSource,
    subscriptionCreatedAt: new Date("2026-07-20T12:00:00.000Z"),
    subscriptionId: 1,
  });
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.articlesDataService.batchUpsertArticles = async () => {
    throw new Error("Database unavailable");
  };
  dependencies.sourcesDataService.enqueueSource = async (source) => {
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

test("queues URL cache misses and email subscriptions", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.config.MAIL_ENABLED = true;
  const additions: Parameters<
    ServerDependencies["userSourcesDataService"]["addSourceToUser"]
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
  dependencies.sourcesDataService.enqueueSource = async (source) => {
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
  expect(enqueues).toEqual([
    [91, subscriptionSource.url],
    [92, "newsletter@example.com"],
  ]);
});

test("triggers WebSub discovery immediately at subscribe time, but not for email targets", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.config.MAIL_ENABLED = true;
  const discoveryCalls: [number, string, string | undefined][] = [];
  dependencies.feedParser.discoverAndSubscribeWebSub = async (
    sourceId,
    url,
    websubStatus,
  ) => {
    discoveryCalls.push([sourceId, url, websubStatus]);
  };
  dependencies.userSourcesDataService.addSourceToUser = async (
    _userId,
    payload,
  ) => ({
    source: {
      ...subscriptionSource,
      id: payload.url.includes("@") ? 94 : 93,
      url: payload.url,
    },
    subscriptionCreatedAt: new Date(),
    subscriptionId: payload.url.includes("@") ? 4 : 3,
  });
  dependencies.userSourcesDataService.withSubscriptionInitializationLease =
    runLease;
  dependencies.sourcesDataService.enqueueSource = async () => {};
  const app = await appFor(dependencies);

  await subscribe(app, {
    sourceFolder: null,
    sourceName: "URL feed",
    sourceUrl: subscriptionSource.url,
  });
  await subscribe(app, {
    sourceFolder: null,
    sourceName: "Newsletter",
    sourceUrl: "newsletter@example.com",
  });

  expect(discoveryCalls).toEqual([
    [93, subscriptionSource.url, subscriptionSource.websubStatus],
  ]);
});

test("protects nonempty folders and deletes empty owned folders", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const deletions: [number, number][] = [];
  dependencies.foldersDataService.removeEmptyUserFolder = async (
    userId,
    folderId,
  ) => {
    deletions.push([userId, folderId]);
    if (folderId === 7) return "not-empty";
    if (folderId === 9) return "not-found";
    return "removed";
  };
  const app = await appFor(dependencies);
  const removeFolder = (folderId: number) =>
    app.handle(
      new Request("http://localhost/api/folders", {
        body: JSON.stringify({ removeFolderId: folderId }),
        headers: {
          "content-type": "application/json",
          cookie: "sid=test",
        },
        method: "DELETE",
      }),
    );

  const nonempty = await removeFolder(7);
  expect(nonempty.status).toBe(409);
  expect(await nonempty.json()).toEqual({ error: "Folder is not empty" });
  expect(deletions).toEqual([[42, 7]]);

  const empty = await removeFolder(8);
  expect(empty.status).toBe(200);
  expect(await empty.json()).toBe(8);
  expect(deletions).toEqual([
    [42, 7],
    [42, 8],
  ]);

  const missing = await removeFolder(9);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "Folder not found" });
  expect(deletions).toEqual([
    [42, 7],
    [42, 8],
    [42, 9],
  ]);
});

test("scopes article detail to the subscriber and always returns Feed content", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const lookups: [number, number][] = [];
  const article = {
    author: "Author",
    content: "<p>Visible</p>",
    debugFetchTrigger: null,
    guid: "visible-guid",
    id: 7,
    lastSeenInFeedAt: new Date(),
    publishedAt: new Date(),
    sourceId: 3,
    title: "Visible article",
    updatedAt: null,
    url: "https://example.com/article",
  };
  dependencies.articlesDataService.getUserArticle = async (
    articleId,
    userId,
  ) => {
    lookups.push([articleId, userId]);
    return articleId === article.id && userId === 42 ? article : undefined;
  };
  const app = await appFor(dependencies);
  const request = (id: number, query = "") =>
    app.handle(
      new Request(`http://localhost/api/article?article=${id}${query}`, {
        headers: { cookie: "sid=test" },
      }),
    );

  const visible = await request(7, "&displayMode=READABILITY");
  const foreign = await request(8);
  const absent = await request(9);

  expect(visible.status).toBe(200);
  const visibleArticle: unknown = await visible.json();
  if (
    typeof visibleArticle !== "object" ||
    visibleArticle === null ||
    !("id" in visibleArticle) ||
    !("content" in visibleArticle)
  ) {
    throw new Error("Invalid article response");
  }
  expect(visibleArticle.id).toBe(7);
  expect(visibleArticle.content).toBe("<p>Visible</p>");
  expect(foreign.status).toBe(404);
  expect(await foreign.json()).toEqual({});
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual({});
  expect(lookups).toEqual([
    [7, 42],
    [8, 42],
    [9, 42],
  ]);
});

test("rejects synthetic requests to /healthcheck", async () => {
  const app = await appFor(createDependencies());
  const response = await app.handle(
    new Request("http://localhost/healthcheck", {
      headers: {
        "x-forwarded-for": "127.0.0.1",
      },
    }),
  );

  expect(response.status).toBe(403);
});

test("allows loopback healthchecks", async () => {
  const app = await appFor(createDependencies());
  app.listen(0);
  try {
    const origin = `http://127.0.0.1:${app.server?.port}`;

    expect((await fetch(`${origin}/healthcheck`)).status).toBe(200);
  } finally {
    await app.stop();
  }
});

test.each([
  ["/api/login", { email: 1 }, 422],
  ["/api/register", {}, 422],
  ["/api/mail", {}, 422],
])("keeps POST %s public", async (path, body, status) => {
  const app = await appFor(createDependencies());
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

  expect(response.status).toBe(status);
});

test("authenticates only active users without revealing account state", async () => {
  const attempts = [
    { email: "missing@example.com", password: "password" },
    { email: account.email, password: "wrong-password" },
    { email: "inactive@example.com", password: "password" },
  ];

  await Promise.all(
    attempts.map(async (attempt) => {
      const dependencies = createDependencies();
      let sessionCalls = 0;
      let dummyHashCalls = 0;
      dependencies.usersDataService.findUser = async (email) => {
        if (email === account.email) return account;
        if (email === "inactive@example.com") {
          return { ...account, email, status: "inactive" };
        }
        return undefined;
      };
      dependencies.password.verify = async (value, hash) =>
        hash === account.password && value === "password";
      dependencies.usersDataService.createSession = async () => {
        sessionCalls++;
        return "unexpected-session";
      };
      dependencies.password.hash = async () => {
        dummyHashCalls++;
        return "dummy-hash";
      };
      const app = await appFor(dependencies);

      const response = await app.handle(
        new Request("http://localhost/api/login", {
          body: JSON.stringify(attempt),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Wrong login data" });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(sessionCalls).toBe(0);
      expect(dummyHashCalls).toBe(
        attempt.email === "missing@example.com" ? 1 : 0,
      );
    }),
  );

  const dependencies = createDependencies();
  dependencies.usersDataService.findUser = async () => account;
  dependencies.password.verify = async (value, hash) =>
    hash === account.password && value === "password";
  const app = await appFor(dependencies);
  const response = await app.handle(
    new Request("http://localhost/api/login", {
      body: JSON.stringify({ email: account.email, password: "password" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sid: "test-session" });
  expect(response.headers.get("set-cookie")).toContain("sid=test-session");
});

test("treats inactive sessions as unauthenticated everywhere", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.getUserBySid = async () => ({
    ...sessionUser,
    status: "inactive",
  });
  const app = await appFor(dependencies);
  const headers = { cookie: "sid=inactive" };

  const session = await app.handle(
    new Request("http://localhost/api/session", { headers }),
  );
  const reader = await app.handle(
    new Request("http://localhost/api/tree", { headers }),
  );

  expect(session.status).toBe(200);
  expect(await session.json()).toEqual({ user: null });
  expect(reader.status).toBe(401);
  expect(await reader.json()).toEqual({ error: "Unauthorized" });
});

test("rejects mismatched registration passwords before the handler", async () => {
  const dependencies = createDependencies();
  let handlerCalls = 0;
  dependencies.usersDataService.getUserCount = async () => {
    handlerCalls++;
    return 0;
  };
  const app = await appFor(dependencies);

  const response = await app.handle(
    new Request("http://localhost/api/register", {
      body: JSON.stringify({
        email: "reader@example.com",
        password: "password",
        passwordConfirm: "different",
        username: "Reader",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

  expect(response.status).toBe(422);
  expect(handlerCalls).toBe(0);
});

test("rejects mismatched password changes before account checks", async () => {
  const dependencies = createDependencies();
  let sessionLookups = 0;
  let accountChecks = 0;
  dependencies.usersDataService.getUserBySid = async () => {
    sessionLookups++;
    return sessionUser;
  };
  dependencies.usersDataService.findUser = async () => {
    accountChecks++;
    return account;
  };
  const app = await appFor(dependencies);

  const response = await app.handle(
    new Request("http://localhost/api/options/password", {
      body: JSON.stringify({
        oldPassword: "old",
        password1: "new-password",
        password2: "different",
      }),
      headers: {
        "content-type": "application/json",
        cookie: "sid=test",
      },
      method: "POST",
    }),
  );

  expect(response.status).toBe(422);
  expect(sessionLookups).toBe(0);
  expect(accountChecks).toBe(0);
});

test("validates admin sort and URL policies before service calls", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.getUserBySid = async () => ({
    ...sessionUser,
    isAdmin: true,
  });
  const sorts: [string, "asc" | "desc"][] = [];
  let updates = 0;
  dependencies.sourcesDataService.listAllSources = async (sortBy, order) => {
    sorts.push([sortBy, order]);
    return [];
  };
  dependencies.sourcesDataService.updateSourceUrl = async () => {
    updates++;
  };
  const app = await appFor(dependencies);
  const cookie = { cookie: "sid=admin" };

  const validSort = await app.handle(
    new Request(
      "http://localhost/api/admin?sortBy=subscriberCount&order=desc",
      { headers: cookie },
    ),
  );
  const invalidSort = await app.handle(
    new Request("http://localhost/api/admin?sortBy=id;drop&order=sideways", {
      headers: cookie,
    }),
  );
  const invalidUpdate = await app.handle(
    new Request("http://localhost/api/admin", {
      body: JSON.stringify({ oldUrl: "not a url", newUrl: "javascript:x" }),
      headers: { ...cookie, "content-type": "application/json" },
      method: "POST",
    }),
  );

  expect(validSort.status).toBe(200);
  expect(invalidSort.status).toBe(422);
  expect(invalidUpdate.status).toBe(422);
  expect(sorts).toEqual([["subscriberCount", "desc"]]);
  expect(updates).toBe(0);
});

test("fails closed when mail ingestion or relay authentication is unavailable", async () => {
  const cases = [
    { enabled: false, expectedStatus: 404, requestSecret: "relay-secret" },
    { enabled: true, expectedStatus: 401, requestSecret: "relay-secret" },
    {
      configuredSecret: "relay-secret",
      enabled: true,
      expectedStatus: 401,
    },
    {
      configuredSecret: "relay-secret",
      enabled: true,
      expectedStatus: 401,
      requestSecret: "wrong-secret-with-different-length",
    },
  ];

  await Promise.all(
    cases.map(async (testCase) => {
      const dependencies = createDependencies();
      dependencies.config.MAIL_ENABLED = testCase.enabled;
      if (testCase.configuredSecret) {
        dependencies.config.MAIL_RELAY_SECRET = testCase.configuredSecret;
      }
      let handlerCalls = 0;
      dependencies.emailHandler.processEmail = async () => {
        handlerCalls++;
      };
      const app = await appFor(dependencies);
      const headers = new Headers({ "content-type": "application/json" });
      if (testCase.requestSecret) {
        headers.set(mailRelaySecretHeader, testCase.requestSecret);
      }

      const response = await app.handle(
        new Request("http://localhost/api/mail", {
          body: JSON.stringify({
            from: "sender@example.com",
            raw: "Subject: Test\r\n\r\nBody",
            to: "reader@example.com",
          }),
          headers,
          method: "POST",
        }),
      );

      expect(response.status).toBe(testCase.expectedStatus);
      expect(handlerCalls).toBe(0);
    }),
  );
});

test("authenticates incoming mail and passes the normalized trusted envelope", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAIL_ENABLED = true;
  dependencies.config.MAIL_RELAY_SECRET = "relay-secret";
  const processed: Array<{
    envelope: { from: string; to: string };
    raw: string;
  }> = [];
  dependencies.emailHandler.processEmail = async (raw, envelope) => {
    if (!Buffer.isBuffer(raw)) throw new Error("Expected buffered mail input");
    processed.push({ envelope, raw: raw.toString("utf8") });
  };
  const app = await appFor(dependencies);

  const response = await app.handle(
    new Request("http://localhost/api/mail", {
      body: JSON.stringify({
        from: "  sender@example.com  ",
        raw: "Subject: Test\r\n\r\nBody",
        to: " reader@example.com ",
      }),
      headers: {
        "content-type": "application/json",
        [mailRelaySecretHeader]: "relay-secret",
      },
      method: "POST",
    }),
  );

  expect(response.status).toBe(200);
  expect(processed).toEqual([
    {
      envelope: {
        from: "sender@example.com",
        to: "reader@example.com",
      },
      raw: "Subject: Test\r\n\r\nBody",
    },
  ]);
});

test("enforces the raw MIME byte limit before EmailHandler", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAIL_ENABLED = true;
  dependencies.config.MAIL_RELAY_SECRET = "relay-secret";
  const sizes: number[] = [];
  dependencies.emailHandler.processEmail = async (raw) => {
    if (!Buffer.isBuffer(raw)) throw new Error("Expected buffered mail input");
    sizes.push(raw.byteLength);
  };
  const app = await appFor(dependencies);
  const mail = (raw: string) =>
    app.handle(
      new Request("http://localhost/api/mail", {
        body: JSON.stringify({
          from: "sender@example.com",
          raw,
          to: "reader@example.com",
        }),
        headers: {
          "content-type": "application/json",
          [mailRelaySecretHeader]: "relay-secret",
        },
        method: "POST",
      }),
    );

  const exact = await mail("a".repeat(maxRawEmailBytes));
  const over = await mail("a".repeat(maxRawEmailBytes + 1));
  const encodedOver = await mail("é".repeat(maxRawEmailBytes / 2 + 1));

  expect(exact.status).toBe(200);
  expect(over.status).not.toBe(200);
  expect(encodedOver.status).not.toBe(200);
  expect(sizes).toEqual([maxRawEmailBytes]);
});

test("rejects malformed mail envelopes before EmailHandler", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAIL_ENABLED = true;
  dependencies.config.MAIL_RELAY_SECRET = "relay-secret";
  let handlerCalls = 0;
  dependencies.emailHandler.processEmail = async () => {
    handlerCalls++;
  };
  const app = await appFor(dependencies);

  const response = await app.handle(
    new Request("http://localhost/api/mail", {
      body: JSON.stringify({
        from: "sender@example.com",
        raw: "Subject: Test\r\n\r\nBody",
      }),
      headers: {
        "content-type": "application/json",
        [mailRelaySecretHeader]: "relay-secret",
      },
      method: "POST",
    }),
  );

  expect(response.status).toBe(422);
  expect(handlerCalls).toBe(0);
});

test("validates OPML files and checks plain-text content before parsing", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const parsed: string[] = [];
  let inserts = 0;
  dependencies.opmlParser.parseOpml = (content) => {
    parsed.push(content);
    return [];
  };
  dependencies.opmlImportService.insertTree = async () => {
    inserts++;
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
  expect(parsed).toEqual(["<opml><body /></opml>"]);
  expect(inserts).toBe(1);
});

test("creates active users without registration integrations", async () => {
  const dependencies = createDependencies();
  let created:
    | Parameters<ServerDependencies["usersDataService"]["createUser"]>[0]
    | undefined;
  let fetchCalls = 0;
  let mailCalls = 0;
  dependencies.fetcher = async () => {
    fetchCalls++;
    throw new Error("Unexpected fetch");
  };
  dependencies.password.hash = async () => "hashed-password";
  dependencies.usersDataService.findUser = async () => undefined;
  dependencies.usersDataService.createUser = async (payload) => {
    created = payload;
    return undefined;
  };
  dependencies.mailSender.sendActivationEmail = async () => {
    mailCalls++;
  };
  const app = await appFor(dependencies);

  const response = await app.handle(
    new Request("http://localhost/api/register", {
      body: JSON.stringify({
        email: "active@example.com",
        password: "password",
        passwordConfirm: "password",
        username: "Active user",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(created).toEqual({
    email: "active@example.com",
    name: "Active user",
    passwordHash: "hashed-password",
    status: "active",
  });
  expect(fetchCalls).toBe(0);
  expect(mailCalls).toBe(0);
});

test.each([
  ["active", false],
  ["inactive", false],
  ["active", true],
  ["inactive", true],
] as const)(
  "returns generic success without mutating an existing %s account when Mailjet=%s",
  async (status, useMailjet) => {
    const dependencies = createDependencies();
    if (useMailjet) {
      dependencies.config.MAILJET_API_KEY = "mailjet-key";
      dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
    }
    const calls: string[] = [];
    dependencies.password.hash = async () => {
      calls.push("hash");
      return "replacement-hash";
    };
    dependencies.usersDataService.findUser = async () => ({
      ...account,
      status,
    });
    dependencies.usersDataService.createUser = async () => {
      calls.push("create");
    };
    dependencies.usersDataService.updatePassword = async () => {
      calls.push("update-password");
    };
    dependencies.usersDataService.activateUser = async () => {
      calls.push("activate");
    };
    dependencies.mailSender.sendActivationEmail = async () => {
      calls.push("send");
    };
    const app = await appFor(dependencies);

    const response = await app.handle(
      new Request("http://localhost/api/register", {
        body: JSON.stringify({
          email: account.email,
          password: "replacement-password",
          passwordConfirm: "replacement-password",
          username: "Replacement name",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(calls).toEqual([]);
  },
);

test("rejects missing or malformed Turnstile responses before database mutation", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.TURNSTILE_SECRET_KEY = "turnstile-secret";
  let fetchCalls = 0;
  let hashCalls = 0;
  let databaseCalls = 0;
  dependencies.fetcher = async () => {
    fetchCalls++;
    return Response.json({ success: "true" });
  };
  dependencies.password.hash = async () => {
    hashCalls++;
    return "hashed-password";
  };
  dependencies.usersDataService.getUserCount = async () => {
    databaseCalls++;
    return 0;
  };
  dependencies.usersDataService.findUser = async () => {
    databaseCalls++;
    return undefined;
  };
  dependencies.usersDataService.createUser = async () => {
    databaseCalls++;
    return undefined;
  };
  dependencies.usersDataService.updatePassword = async () => {
    databaseCalls++;
  };
  dependencies.usersDataService.activateUser = async () => {
    databaseCalls++;
  };
  const app = await appFor(dependencies);
  const register = (token?: string) =>
    app.handle(
      new Request("http://localhost/api/register", {
        body: JSON.stringify({
          email: "protected@example.com",
          password: "password",
          passwordConfirm: "password",
          username: "Protected user",
          ...(token ? { "cf-turnstile-response": token } : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

  const missing = await register();
  const failed = await register("invalid-token");

  expect(missing.status).toBe(400);
  expect(failed.status).toBe(400);
  expect(await missing.json()).toEqual({
    error: "Invalid CAPTCHA",
    success: false,
  });
  expect(await failed.json()).toEqual({
    error: "Invalid CAPTCHA",
    success: false,
  });
  expect(fetchCalls).toBe(1);
  expect(hashCalls).toBe(0);
  expect(databaseCalls).toBe(0);
});

test("creates inactive users and sends one activation email with Mailjet", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  dependencies.password.hash = async () => "hashed-password";
  let created:
    | Parameters<ServerDependencies["usersDataService"]["createUser"]>[0]
    | undefined;
  const sent: [string, string][] = [];
  const events: string[] = [];
  dependencies.usersDataService.createUser = async (payload) => {
    events.push("create");
    created = payload;
    return undefined;
  };
  dependencies.mailSender.sendActivationEmail = async (email, token) => {
    events.push("send");
    sent.push([email, token]);
  };
  const app = await appFor(dependencies);

  const startedAt = Date.now();
  const response = await app.handle(
    new Request("http://localhost/api/register", {
      body: JSON.stringify({
        email: "inactive@example.com",
        password: "password",
        passwordConfirm: "password",
        username: "Inactive user",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  const finishedAt = Date.now();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  if (!created?.activationToken || !created.activationTokenExpiresAt)
    throw new Error("Activation fields were not created");
  expect(created.status).toBe("inactive");
  expect(created.activationToken).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(created.activationTokenExpiresAt.getTime()).toBeGreaterThanOrEqual(
    startedAt + 24 * 60 * 60 * 1_000,
  );
  expect(created.activationTokenExpiresAt.getTime()).toBeLessThanOrEqual(
    finishedAt + 24 * 60 * 60 * 1_000,
  );
  expect(sent).toEqual([["inactive@example.com", created.activationToken]]);
  expect(events).toEqual(["send", "create"]);
});

test("does not create an inactive user when activation email delivery fails", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  let createCalls = 0;
  dependencies.usersDataService.createUser = async () => {
    createCalls++;
    return undefined;
  };
  dependencies.mailSender.sendActivationEmail = async () => {
    throw new Error("Mailjet unavailable");
  };
  const app = await appFor(dependencies);

  const response = await app.handle(
    new Request("http://localhost/api/register", {
      body: JSON.stringify({
        email: "inactive@example.com",
        password: "password",
        passwordConfirm: "password",
        username: "Inactive user",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

  expect(response.status).toBe(500);
  expect(createCalls).toBe(0);
});

test("activates valid tokens but rejects expired tokens", async () => {
  const dependencies = createDependencies();
  const activated: number[] = [];
  const tokenLookups: string[] = [];
  dependencies.usersDataService.findUserByActivationToken = async (token) => {
    tokenLookups.push(token);
    return {
      ...account,
      activationToken: token,
      activationTokenExpiresAt:
        token === "valid"
          ? new Date(Date.now() + 60_000)
          : new Date(Date.now() - 60_000),
      id: token === "valid" ? 1 : 2,
      status: "inactive",
    };
  };
  dependencies.usersDataService.activateUser = async (id) => {
    activated.push(id);
  };
  const app = await appFor(dependencies);

  const valid = await app.handle(
    new Request("http://localhost/api/activate/valid", { method: "POST" }),
  );
  const expired = await app.handle(
    new Request("http://localhost/api/activate/expired", { method: "POST" }),
  );
  const blank = await app.handle(
    new Request("http://localhost/api/activate/%20%20", { method: "POST" }),
  );

  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ success: true });
  expect(expired.status).toBe(400);
  expect(await expired.json()).toEqual({
    error: "Invalid activation token.",
  });
  expect(blank.status).toBe(422);
  expect(activated).toEqual([1]);
  expect(tokenLookups).toEqual(["valid", "expired"]);
});

test("allows admin sessions and rejects non-admin sessions", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.getUserBySid = async (sid) => ({
    ...sessionUser,
    isAdmin: sid === "admin",
  });
  const app = await appFor(dependencies);

  const adminResponse = await app.handle(
    new Request("http://localhost/api/admin", {
      headers: { cookie: "sid=admin" },
    }),
  );
  const readerResponse = await app.handle(
    new Request("http://localhost/api/admin", {
      headers: { cookie: "sid=reader" },
    }),
  );

  expect(adminResponse.status).toBe(200);
  expect(readerResponse.status).toBe(403);
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
  dependencies.sourcesDataService.findSourceByWebSubCallbackToken = async (
    token,
  ) => (token === "callback-token" ? websubSource : undefined);
  dependencies.sourcesDataService.markWebSubVerified = async (id, lease) => {
    verifiedId = id;
    verifiedLease = lease;
  };
  const app = await appFor(dependencies);

  const response = await app.handle(
    new Request(
      "http://localhost/api/websub/callback/callback-token?" +
        new URLSearchParams({
          "hub.challenge": "abc123",
          "hub.lease_seconds": "600",
          "hub.mode": "subscribe",
          "hub.topic": websubSource.websubTopicUrl,
        }),
    ),
  );

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("abc123");
  expect(verifiedId).toBe(websubSource.id);
  expect(verifiedLease?.getTime()).toBeGreaterThan(Date.now());
});

test("WebSub callback verification 404s for an unknown token or mismatched topic", async () => {
  const dependencies = createDependencies();
  dependencies.sourcesDataService.findSourceByWebSubCallbackToken = async (
    token,
  ) => (token === "callback-token" ? websubSource : undefined);
  dependencies.sourcesDataService.markWebSubVerified = async () =>
    unexpected("sourcesDataService.markWebSubVerified");
  const app = await appFor(dependencies);

  const unknownToken = await app.handle(
    new Request(
      "http://localhost/api/websub/callback/nope?" +
        new URLSearchParams({
          "hub.challenge": "abc123",
          "hub.mode": "subscribe",
          "hub.topic": websubSource.websubTopicUrl,
        }),
    ),
  );
  const mismatchedTopic = await app.handle(
    new Request(
      "http://localhost/api/websub/callback/callback-token?" +
        new URLSearchParams({
          "hub.challenge": "abc123",
          "hub.mode": "subscribe",
          "hub.topic": "https://someone-else.example/feed",
        }),
    ),
  );

  expect(unknownToken.status).toBe(404);
  expect(mismatchedTopic.status).toBe(404);
});

test("WebSub push requires a valid signature and then enqueues an immediate re-fetch", async () => {
  const dependencies = createDependencies();
  const enqueued: Parameters<
    ServerDependencies["sourcesDataService"]["enqueueSource"]
  >[] = [];
  dependencies.sourcesDataService.findSourceByWebSubCallbackToken = async (
    token,
  ) => (token === "callback-token" ? websubSource : undefined);
  dependencies.sourcesDataService.enqueueSource = async (...parameters) => {
    enqueued.push(parameters);
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
      headers: { "x-hub-signature-256": validSignature },
      method: "POST",
    }),
  );

  expect(wrongSignature.status).toBe(403);
  expect(validPush.status).toBe(200);
  expect(enqueued).toEqual([
    [{ id: websubSource.id, url: websubSource.url }, "websub-push"],
  ]);
});

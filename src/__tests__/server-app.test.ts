import type { AppConfig } from "#platform/config.ts";
import type { RedirectMap } from "#features/feeds/redirect-map.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import type { EmailHandler } from "#features/mail-ingest/email-handler.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { FeedPreviewCache } from "#features/feeds/feed-preview-cache.ts";
import type { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import type { MailSender } from "#features/auth/mail-sender.ts";
import type { OpmlImportService } from "#features/feeds/opml-import-service.ts";
import type { OutboundFetchBudget } from "#features/feeds/outbound-fetch-budget.ts";
import type { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";
import type { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import {
  ArticleEventHub,
  type ArticleEventSubscriber,
} from "#features/reader/article-event-hub.ts";
import { articleEventsChannel } from "#features/feeds/article-events.ts";
import { ArticleImporter } from "#features/feeds/article-import.ts";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { Value } from "typebox/value";
import { sessionResponse } from "#shared/contracts/responses.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
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
import { AuthThrottle } from "#features/auth/auth-throttle.ts";
import { createFakeThrottleRedis } from "#features/auth/__tests__/fake-throttle-redis.ts";
import {
  createServerApp,
  MAX_REQUEST_BODY_BYTES,
  type ServerServices,
} from "../server-app.ts";

const spaDirectory = resolve(import.meta.dir, "../spa");
const mailRelaySecretHeader = "x-feedfathom-mail-secret";
const maxRawEmailBytes = 5 * 1_024 * 1_024;
const relayed = (raw: string) => Buffer.from(raw).toString("base64");
const relayMail = (app: App, envelope: Record<string, unknown>) =>
  post(app, "/api/mail", envelope, {
    headers: { [mailRelaySecretHeader]: "relay-secret" },
  });

const runLease: UserSourcesDataService["withSubscriptionInitializationLease"] =
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
  passwordResetTokenExpiresAt: null,
  passwordResetTokenHash: null,
  status: "active" as const,
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
};

// Writable, so a test can swap a whole service rather than one method.
type Dependencies = {
  -readonly [Key in keyof ServerServices]: ServerServices[Key];
};

// Every service a request can reach, each a strict fake: the defaults below
// answer the reads most routes make on the way in, and anything else a test
// has not arranged throws and names itself.
function createDependencies(): Dependencies {
  const config: AppConfig = {
    ALLOWED_EMAILS: [],
    ARTICLE_STALE_AFTER_DAYS: 365,
    CLEANUP_INTERVAL: 1_000,
    DATABASE_URL: "postgres://feedfathom:feedfathom@localhost/feedfathom",
    DB_POOL_MAX: 10,
    ENABLE_REGISTRATION: false,
    GATHER_JOBS_INTERVAL: 1_000,
    LOCK_DURATION: 1_000,
    MAIL_ENABLED: false,
    REDIS_URL: "redis://localhost:6379",
    SLOW_REQUEST_MS: 500,
    USER_DORMANT_AFTER_DAYS: 365,
    USER_EXPIRY_DAYS: 730,
    WORKER_CONCURRENCY: 1,
  };
  const articlesDataService = strictFake<ArticlesDataService>(
    {
      async getUserArticle() {
        return undefined;
      },
      async getUserArticlesForSources() {
        return [];
      },
    },
    "articlesDataService",
  );
  const userSourcesDataService = strictFake<UserSourcesDataService>(
    {
      async getUserSourceIds() {
        return [];
      },
      async getUserSources() {
        return [];
      },
    },
    "userSourcesDataService",
  );
  const usersDataService: UsersDataService = strictFake<UsersDataService>(
    {
      // Resolves through getUserBySid, so a test names the signed-in user
      // once and both the read-only lookup and the auth plugin see it.
      async authenticate(sid) {
        return await usersDataService.getUserBySid(sid);
      },
      async createSession() {
        return "test-session";
      },
      async deleteOtherSessions() {},
      async deleteSession() {},
      async deleteSessionById() {},
      async findUser() {
        return undefined;
      },
      async findUserByActivationToken() {
        return undefined;
      },
      async findUserByPasswordResetToken() {
        return undefined;
      },
      async getUserBySid() {
        return undefined;
      },
      async getUserCount() {
        return 0;
      },
      async listSessions() {
        return [];
      },
    },
    "usersDataService",
  );
  return {
    articleEventHub: strictFake<ArticleEventHub>(
      { close: () => {} },
      "articleEventHub",
    ),
    // The real importer over the fakes, so a test's batchUpsertArticles and
    // recomputeUnreadCounts replacements are what subscribe reaches.
    articleImporter: new ArticleImporter(
      articlesDataService,
      userSourcesDataService,
      { publish() {} },
    ),
    articlesDataService,
    authThrottle: new AuthThrottle(createFakeThrottleRedis()),
    config,
    emailHandler: strictFake<EmailHandler>({}, "emailHandler"),
    feedParser: strictFake<FeedParser>(
      {
        async discoverAndSubscribeWebSub() {},
        async preview() {
          return undefined;
        },
      },
      "feedParser",
    ),
    feedPreviewCache: strictFake<FeedPreviewCache>(
      {
        async get() {
          return undefined;
        },
        async save() {},
      },
      "feedPreviewCache",
    ),
    fetcher: async () => Response.json({ success: false }),
    foldersDataService: strictFake<FoldersDataService>(
      {
        async getUserFolders() {
          return [];
        },
      },
      "foldersDataService",
    ),
    httpClient: strictFake<ServerServices["httpClient"]>(
      {
        async seedCache() {},
      },
      "httpClient",
    ),
    mailSender: strictFake<MailSender>(
      {
        async sendAccountExistsEmail() {},
        async sendActivationEmail() {},
        async sendPasswordResetEmail() {},
      },
      "mailSender",
    ),
    opmlImportService: strictFake<OpmlImportService>({}, "opmlImportService"),
    outboundFetchBudget: strictFake<OutboundFetchBudget>(
      { async consume() {} },
      "outboundFetchBudget",
    ),
    password: {
      async hash(value) {
        return `hashed:${value}`;
      },
      async verify(value, hash) {
        return hash === `hashed:${value}`;
      },
    },
    redirectMap: strictFake<RedirectMap>(
      {
        async getAllRedirects() {
          return {};
        },
        async removeRedirect() {},
      },
      "redirectMap",
    ),
    sourceEnqueuer: strictFake<SourceEnqueuer>(
      { async enqueueSource() {} },
      "sourceEnqueuer",
    ),
    sourcesDataService: strictFake<SourcesDataService>(
      {
        async deleteSource() {},
        async getFavicon() {
          return null;
        },
        async listAllSources() {
          return [];
        },
        async successSource() {},
        async updateSourceUrl() {
          return "updated";
        },
      },
      "sourcesDataService",
    ),
    userSourcesDataService,
    usersDataService,
    websubStateService: strictFake<WebSubStateService>(
      {
        async findSourceByWebSubCallbackToken() {
          return undefined;
        },
      },
      "websubStateService",
    ),
  };
}

const appFor = async (dependencies: Dependencies, production = false) =>
  createServerApp(dependencies, { production, spaDirectory });

type App = Awaited<ReturnType<typeof appFor>>;
type RequestOptions = {
  // Sends the session cookie a test's getUserBySid answers for.
  auth?: boolean;
  headers?: Record<string, string>;
  origin?: string;
};

// One request through the whole app. A body is sent as JSON.
const send = (
  app: App,
  method: string,
  path: string,
  body?: unknown,
  {
    auth = false,
    headers = {},
    origin = "http://localhost",
  }: RequestOptions = {},
) =>
  app.handle(
    new Request(`${origin}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        ...(auth ? { cookie: "sid=test" } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
    }),
  );
const get = (app: App, path: string, options?: RequestOptions) =>
  send(app, "GET", path, undefined, options);
const post = (
  app: App,
  path: string,
  body?: unknown,
  options?: RequestOptions,
) => send(app, "POST", path, body, options);

const authenticated = (dependencies: Dependencies) => {
  dependencies.usersDataService.getUserBySid = async () => sessionUser;
};

// The session row's activity stamp and device label are refreshed by the
// auth plugin on every request that resolves the cookie -- if the plugin
// stops passing the User-Agent along, the options list quietly reverts to
// login-time snapshots and nothing else in the app would notice.
test("each authenticated request refreshes the session row", async () => {
  const dependencies = createDependencies();
  const authenticatedWith: Parameters<UsersDataService["authenticate"]>[] = [];
  dependencies.usersDataService.authenticate = async (...args) => {
    authenticatedWith.push(args);
    return sessionUser;
  };
  const app = await appFor(dependencies);

  await get(app, "/api/options/sessions", {
    auth: true,
    headers: { "user-agent": "Mozilla/5.0 TestClient" },
  });
  expect(authenticatedWith).toEqual([["test", "Mozilla/5.0 TestClient"]]);

  // A request without a cookie has no row to refresh -- the plugin answers
  // 401 without reaching the database.
  authenticatedWith.length = 0;
  const unauthorized = await get(app, "/api/options/sessions", {
    headers: { "user-agent": "Mozilla/5.0 TestClient" },
  });
  expect(unauthorized.status).toBe(401);
  expect(authenticatedWith).toEqual([]);
});

// MAIL_DOMAIN is where inbound mail is routed and FEED_FATHOM_DOMAIN is
// where the app is served; they coincide only in single-domain setups, so
// the app host is a fallback and never an override.
test.each([
  [false, "feeds.example.com", undefined, undefined],
  [true, "", undefined, undefined],
  [true, "feeds.example.com:8443", undefined, "feeds.example.com"],
  [true, "app.example.com", "mail.example.com", "mail.example.com"],
  // Blank is unset, not an override: compose.yml always defines MAIL_DOMAIN.
  [true, "app.example.com", "", "app.example.com"],
  [true, "", "", undefined],
])(
  "advertises the newsletter domain only with mail enabled (%p, %p, %p)",
  async (mailEnabled, domain, mailDomain, expected) => {
    const dependencies = createDependencies();
    authenticated(dependencies);
    dependencies.config.MAIL_ENABLED = mailEnabled;
    dependencies.config.FEED_FATHOM_DOMAIN = domain;
    if (mailDomain !== undefined) dependencies.config.MAIL_DOMAIN = mailDomain;
    const app = await appFor(dependencies);

    const response = await get(app, "/api/session", { auth: true });
    const body: unknown = await response.json();

    expect(Value.Check(sessionResponse, body)).toBe(true);
    expect(body).toEqual({
      ...(expected === undefined ? {} : { mailDomain: expected }),
      user: sessionUser,
    });
  },
);

test("ends only the current session and clears its cookie", async () => {
  const dependencies = createDependencies();
  const deleted: string[] = [];
  dependencies.usersDataService.deleteSession = async (sid) => {
    deleted.push(sid);
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/logout", undefined, {
    headers: { cookie: "sid=current-session" },
  });
  const withoutCookie = await post(app, "/api/logout");

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

const subscribe = (
  app: Awaited<ReturnType<typeof createServerApp>>,
  body: Record<string, unknown>,
) =>
  post(app, "/api/subscribe", body, {
    auth: true,
    origin: "https://reader.example",
  });

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
  const response = await get(app, path, { headers: { accept } });

  expect(response.status).toBe(status);
  if (contentType)
    expect(response.headers.get("content-type")).toContain(contentType);
});

test.each([
  ["/", false],
  ["/index.html", false],
  ["/settings", false],
  ["/", true],
  ["/index.html", true],
  ["/settings", true],
])(
  "restricts scripts on the %s shell, allowing Turnstile only when enabled: %p",
  async (path, turnstileEnabled) => {
    const dependencies = createDependencies();
    if (turnstileEnabled) dependencies.config.TURNSTILE_SITE_KEY = "site-key";
    const app = await appFor(dependencies, true);
    const response = await get(app, path, { headers: { accept: "text/html" } });

    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toStartWith("script-src 'self' 'sha256-");
    expect(policy).not.toContain("default-src");
    expect(policy.includes("https://challenges.cloudflare.com")).toBe(
      turnstileEnabled,
    );
  },
);

// A cookie whose sid resolves to nobody -- expired, revoked by logout or a
// password reset, or never issued -- is exactly as unauthorised as no cookie.
test.each([
  ["GET", "/api/preview?feedUrl=https%3A%2F%2Ffeed.example%2Frss"],
  ["GET", "/api/find?link=https%3A%2F%2Fsite.example%2F"],
  ["GET", "/api/article?article=1"],
  ["GET", "/api/tree"],
  ["GET", "/api/events"],
  ["GET", "/api/folders"],
  ["GET", "/api/options/sessions"],
  ["DELETE", "/api/options/sessions"],
  ["DELETE", "/api/options/sessions/7"],
  ["POST", "/api/articles"],
])(
  "rejects %s %s with no cookie and with an unknown one",
  async (method, path) => {
    const app = await appFor(createDependencies());
    const body = method === "POST" ? { sources: [3] } : undefined;

    const responses = await Promise.all(
      [false, true].map((auth) => send(app, method, path, body, { auth })),
    );

    const outcomes = await Promise.all(
      responses.map(async (r) => [r.status, await r.json()]),
    );
    expect({ missingCookie: outcomes[0], unknownCookie: outcomes[1] }).toEqual({
      missingCookie: [401, { error: "Unauthorized" }],
      unknownCookie: [401, { error: "Unauthorized" }],
    });
  },
);

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

  const articles = await post(
    app,
    "/api/articles",
    { sources: [3, 5] },
    { auth: true },
  );
  const malformedArticles = await post(
    app,
    "/api/articles",
    { sources: [3, "nope"] },
    { auth: true },
  );
  const largeSources = Array.from({ length: 501 }, (_, index) => index + 1);
  const largeArticleRequest = await post(
    app,
    "/api/articles",
    { sources: largeSources },
    { auth: true },
  );
  const folder = await post(
    app,
    "/api/folders",
    { name: "  Reading  " },
    { auth: true },
  );
  const blankFolder = await post(
    app,
    "/api/folders",
    { name: "   " },
    { auth: true },
  );

  expect(articles.status).toBe(200);
  expect(malformedArticles.status).toBe(422);
  expect(largeArticleRequest.status).toBe(422);
  expect(folder.status).toBe(200);
  expect(blankFolder.status).toBe(422);
  expect(articleQueries).toEqual([[[3, 5], 42]]);
  expect(folders).toEqual([[42, "Reading"]]);
});

test("routes the Today view to every subscribed source with a 24h window", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const calls: Parameters<ArticlesDataService["getUserArticlesForSources"]>[] =
    [];
  dependencies.articlesDataService.getUserArticlesForSources = async (
    ...args
  ) => {
    calls.push(args);
    return [];
  };
  const app = await appFor(dependencies);

  const today = await post(
    app,
    "/api/articles",
    { sources: [], view: "today" },
    { auth: true },
  );
  const unknownView = await post(
    app,
    "/api/articles",
    { sources: [3], view: "week" },
    { auth: true },
  );

  expect(today.status).toBe(200);
  expect(unknownView.status).toBe(422);
  expect(calls).toEqual([
    [
      [],
      42,
      undefined,
      undefined,
      { allSubscribed: true, publishedWithinHours: 24 },
    ],
  ]);
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
  const cached: Parameters<ServerServices["feedPreviewCache"]["save"]>[] = [];
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
    return undefined;
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

test("protects nonempty folders and deletes empty owned folders", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const deletions: Parameters<FoldersDataService["removeEmptyUserFolder"]>[] =
    [];
  dependencies.foldersDataService.removeEmptyUserFolder = async (...args) => {
    deletions.push(args);
    const [, folderId] = args;
    if (folderId === 7) return "not-empty";
    if (folderId === 9) return "not-found";
    return "removed";
  };
  const app = await appFor(dependencies);
  const removeFolder = (folderId: number) =>
    send(
      app,
      "DELETE",
      "/api/folders",
      { removeFolderId: folderId },
      { auth: true },
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
    enclosures: [],
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
    get(app, `/api/article?article=${id}${query}`, { auth: true });

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
  const response = await get(app, "/healthcheck", {
    headers: { "x-forwarded-for": "127.0.0.1" },
  });

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

test("rejects an oversized body before any handler runs", async () => {
  const app = await appFor(createDependencies());
  app.listen(0);
  try {
    const origin = `http://127.0.0.1:${app.server?.port}`;
    const oversized = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);

    const response = await fetch(`${origin}/api/login`, {
      body: JSON.stringify({ email: oversized }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(413);
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
  const response = await post(app, path, body);

  expect(response.status).toBe(status);
});

test("authenticates only active users without revealing account state", async () => {
  const attempts = [
    { email: "missing@example.com", password: "password" },
    { email: account.email, password: "wrong-password" },
    { email: "inactive@example.com", password: "password" },
  ];

  /* eslint-disable no-await-in-loop -- Sequential, so a failure names the case that broke. */
  for (const attempt of attempts) {
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

    const response = await post(app, "/api/login", attempt);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Wrong login data" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(sessionCalls).toBe(0);
    expect(dummyHashCalls).toBe(
      attempt.email === "missing@example.com" ? 1 : 0,
    );
  }
  /* eslint-enable no-await-in-loop */

  const dependencies = createDependencies();
  dependencies.usersDataService.findUser = async () => account;
  dependencies.password.verify = async (value, hash) =>
    hash === account.password && value === "password";
  const app = await appFor(dependencies);
  const response = await post(app, "/api/login", {
    email: account.email,
    password: "password",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sid: "test-session" });
  expect(response.headers.get("set-cookie")).toContain("sid=test-session");
});

// The options page's session list is only as distinguishable as the stored
// agents: the route must hand the request's own User-Agent to createSession
// instead of a hardcoded blank. A missing header stays null here -- the
// "UNKNOWN" fallback is the data layer's decision.
test("login stores the request's user agent on the created session", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.findUser = async () => account;
  dependencies.password.verify = async (value, hash) =>
    hash === account.password && value === "password";
  const createdSessions: Array<{
    passwordHash: string;
    userId: number;
    userAgent: null | string | undefined;
  }> = [];
  dependencies.usersDataService.createSession = async (
    userId,
    passwordHash,
    userAgent,
  ) => {
    createdSessions.push({ passwordHash, userAgent, userId });
    return "test-session";
  };
  const app = await appFor(dependencies);
  const login = (userAgent?: string) =>
    post(
      app,
      "/api/login",
      { email: account.email, password: "password" },
      {
        headers: userAgent === undefined ? {} : { "user-agent": userAgent },
      },
    );

  expect((await login("Mozilla/5.0 FeedFathom Test")).status).toBe(200);
  expect((await login()).status).toBe(200);
  expect(createdSessions).toEqual([
    {
      passwordHash: account.password,
      userAgent: "Mozilla/5.0 FeedFathom Test",
      userId: account.id,
    },
    { passwordHash: account.password, userAgent: null, userId: account.id },
  ]);
});

// The session is issued against the hash the route verified. When a reset
// replaced it in between, the store issues nothing and the login is answered
// like any wrong password: no cookie, and the failure still counts (#843).
test("login refuses when the verified password was replaced before issuance", async () => {
  const dependencies = createDependencies();
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  dependencies.usersDataService.findUser = async () => account;
  dependencies.password.verify = async (value, hash) =>
    hash === account.password && value === "password";
  dependencies.usersDataService.createSession = async () => undefined;
  const throttled: string[] = [];
  dependencies.authThrottle = strictFake<AuthThrottle>({
    async blocked() {
      return false;
    },
    async clearFailures() {
      throttled.push("clear");
    },
    async recordFailure() {
      throttled.push("failure");
    },
  });
  const app = await appFor(dependencies);

  const response = await post(
    app,
    "/api/login",
    { email: account.email, password: "password" },
    { headers: { "x-forwarded-for": "203.0.113.9" } },
  );

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Wrong login data" });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(throttled).toEqual(["failure"]);
});

// Equal-time hashing on a miss closes the enumeration oracle but buys little
// on its own: an attacker who cannot tell accounts apart can still try
// passwords as fast as the box answers. The README's reverse-proxy setup adds
// no rate limiting of its own, so this cannot be left to the deployment.
test("stops guessing at one account from one address", async () => {
  const target = { ...account, email: "throttled@example.com" };
  const dependencies = createDependencies();
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  dependencies.usersDataService.findUser = async (email) =>
    email === target.email ? target : undefined;
  dependencies.password.verify = async (value, hash) =>
    hash === target.password && value === "password";
  const app = await appFor(dependencies);
  const attempt = (password: string, address: string) =>
    post(
      app,
      "/api/login",
      { email: target.email, password },
      { headers: { "x-forwarded-for": address } },
    );

  for (let guess = 0; guess < 10; guess++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    expect((await attempt("wrong", "203.0.113.7")).status).toBe(401);
  }

  // Same body and status as a wrong password, so the throttle does not become
  // the enumeration signal the equal-time hashing was there to avoid.
  const throttled = await attempt("password", "203.0.113.7");
  expect(throttled.status).toBe(401);
  expect(await throttled.json()).toEqual({ error: "Wrong login data" });

  // The account itself is not locked: the counter is keyed on the address as
  // well, so hammering an address cannot shut its owner out from elsewhere.
  const elsewhere = await attempt("password", "198.51.100.4");
  expect(elsewhere.status).toBe(200);
});

test("marks articles read and recomputes the badge from the store", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const marked: { articleIdList: number[]; read: boolean }[] = [];
  const recomputed: [number[], number | undefined][] = [];
  dependencies.articlesDataService.setUserArticlesRead = async (
    articleIdList,
    _userId,
    read,
  ) => {
    marked.push({ articleIdList, read });
    return { articleIds: articleIdList, sourceIds: [3] };
  };
  dependencies.userSourcesDataService.recomputeUnreadCounts = async (
    sourceIds,
    userId,
  ) => {
    recomputed.push([sourceIds, userId]);
  };
  const app = await appFor(dependencies);
  const patch = (body: unknown) =>
    send(app, "PATCH", "/api/articles", body, { auth: true });

  const read = await patch({ articleIdList: [11, 12], read: true });
  const unread = await patch({ articleIdList: [11], read: false });
  const malformed = await patch({ articleIdList: [], read: true });
  const anonymous = await send(app, "PATCH", "/api/articles", {
    articleIdList: [11],
    read: true,
  });

  expect(read.status).toBe(200);
  expect(await read.json()).toEqual([11, 12]);
  expect(unread.status).toBe(200);
  // An empty list is a client bug, not a no-op worth accepting.
  expect(malformed.status).toBe(422);
  expect(anonymous.status).toBe(401);
  expect(marked).toEqual([
    { articleIdList: [11, 12], read: true },
    { articleIdList: [11], read: false },
  ]);
  // The badge is recomputed rather than adjusted by a delta kept in the route.
  expect(recomputed).toEqual([
    [[3], sessionUser.id],
    [[3], sessionUser.id],
  ]);
});

test("passes the article list filter through to the query", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const filters: (string | undefined)[] = [];
  dependencies.articlesDataService.getUserArticlesForSources = async (
    _sources,
    _userId,
    _cursor,
    filter,
  ) => {
    filters.push(filter);
    return [];
  };
  const app = await appFor(dependencies);
  const list = (body: unknown) =>
    post(app, "/api/articles", body, { auth: true });

  await list({ sources: [3] });
  await list({ filter: "read", sources: [3] });
  await list({ filter: "all", sources: [3] });
  const rejected = await list({ filter: "everything", sources: [3] });

  // Absent means unread, which is all the list has ever shown; the default
  // lives in the data service rather than being spelled out per caller.
  expect(filters).toEqual([undefined, "read", "all"]);
  expect(rejected.status).toBe(422);
});

// A bundle from before #992 rejects the extra field, so only a request that
// asks gets it.
test("lists article revisions only when asked", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.articlesDataService.getUserArticlesForSources = async () => [
    {
      author: "A",
      group: "Today",
      id: 11,
      publishedAt: new Date("2026-10-06T10:00:00.000Z"),
      read: false,
      revision: "2026-10-06 10:00:00.000001+00",
      sourceId: 3,
      title: "T",
      url: "https://articles.example/1",
    },
  ];
  const app = await appFor(dependencies);
  const list = async (body: unknown) => {
    const response = await post(app, "/api/articles", body, { auth: true });
    const rows: { revision?: string }[] = await response.json();
    return rows.map((row) => row.revision);
  };

  expect(await list({ sources: [3] })).toEqual([undefined]);
  expect(await list({ revision: true, sources: [3] })).toEqual([
    "2026-10-06 10:00:00.000001+00",
  ]);
});

test("searches every subscription rather than the selected sources", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const calls: { options: unknown; sources: number[] }[] = [];
  dependencies.articlesDataService.getUserArticlesForSources = async (
    sources,
    _userId,
    _cursor,
    _filter,
    options,
  ) => {
    calls.push({ options, sources });
    return [];
  };
  const app = await appFor(dependencies);
  const list = (body: unknown) =>
    post(app, "/api/articles", body, { auth: true });

  const searched = await list({ query: "  service mesh ", sources: [] });
  const scoped = await list({ query: "mesh", sources: [3] });
  const blank = await list({ query: "   ", sources: [] });
  const tooLong = await list({ query: "x".repeat(201), sources: [] });
  const noQuery = await list({ sources: [] });

  expect(searched.status).toBe(200);
  expect(scoped.status).toBe(200);
  // Trimmed, and `sources` is ignored the way the Today view ignores it: the
  // point of search is the article whose feed the reader has forgotten.
  expect(calls).toEqual([
    { options: { allSubscribed: true, query: "service mesh" }, sources: [] },
    { options: { allSubscribed: true, query: "mesh" }, sources: [3] },
  ]);
  expect(blank.status).toBe(422);
  expect(tooLong.status).toBe(422);
  // No query and no sources is still the early return, not a search for
  // everything.
  expect(noQuery.status).toBe(200);
  expect(await noQuery.json()).toEqual([]);
});

test("snoozes and unsnoozes one subscription without touching article state", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const snoozed: { pausedUntil: Date | null; sourceId: number }[] = [];
  dependencies.userSourcesDataService.setSourceSnooze = async (
    _userId,
    sourceId,
    pausedUntil,
  ) => {
    snoozed.push({ pausedUntil, sourceId });
    if (sourceId === 9) return undefined;
    return { id: sourceId, pausedUntil };
  };
  const app = await appFor(dependencies);
  const snooze = (body: unknown, authed = true) =>
    send(app, "PATCH", "/api/source/snooze", body, { auth: authed });

  const snoozeWeek = await snooze({
    pausedUntil: "2026-09-16T12:00:00.000Z",
    sourceId: 3,
  });
  const unsnooze = await snooze({ pausedUntil: null, sourceId: 3 });
  const unknown = await snooze({
    pausedUntil: "2026-09-16T12:00:00.000Z",
    sourceId: 9,
  });
  const malformed = await snooze({ pausedUntil: "next week", sourceId: 3 });
  const anonymous = await snooze({ pausedUntil: null, sourceId: 3 }, false);

  expect(snoozeWeek.status).toBe(200);
  expect(await snoozeWeek.json()).toEqual({
    pausedUntil: "2026-09-16T12:00:00.000Z",
    sourceId: 3,
  });
  expect(unsnooze.status).toBe(200);
  expect(await unsnooze.json()).toEqual({ pausedUntil: null, sourceId: 3 });
  expect(unknown.status).toBe(400);
  expect(malformed.status).toBe(422);
  expect(anonymous.status).toBe(401);
  expect(snoozed).toEqual([
    { pausedUntil: new Date("2026-09-16T12:00:00.000Z"), sourceId: 3 },
    { pausedUntil: null, sourceId: 3 },
    { pausedUntil: new Date("2026-09-16T12:00:00.000Z"), sourceId: 9 },
  ]);
});

test("rejects mismatched registration passwords before the handler", async () => {
  const dependencies = createDependencies();
  let handlerCalls = 0;
  dependencies.usersDataService.getUserCount = async () => {
    handlerCalls++;
    return 0;
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/register", {
    email: "reader@example.com",
    password: "password",
    passwordConfirm: "different",
    username: "Reader",
  });

  expect(response.status).toBe(422);
  expect(handlerCalls).toBe(0);
});

test("rejects mismatched password changes before account checks", async () => {
  const dependencies = createDependencies();
  let accountChecks = 0;
  authenticated(dependencies);
  dependencies.usersDataService.findUser = async () => {
    accountChecks++;
    return account;
  };
  const app = await appFor(dependencies);

  const response = await post(
    app,
    "/api/options/password",
    {
      oldPassword: "old",
      password1: "new-password",
      password2: "different",
    },
    { auth: true },
  );

  expect(response.status).toBe(422);
  expect(accountChecks).toBe(0);
});

// The write is conditional on the hash the handler verified, so a reset that
// committed while the replacement was hashing wins and the change is refused
// rather than reported as done (#977).
test("refuses a password change whose verified password was replaced", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.getUserBySid = async () => sessionUser;
  dependencies.usersDataService.findUser = async () => account;
  dependencies.password.verify = async (value, hash) =>
    hash === account.password && value === "old-password";
  dependencies.password.hash = async () => "replacement-hash";
  const updates: Parameters<UsersDataService["updatePassword"]>[] = [];
  dependencies.usersDataService.updatePassword = async (...args) => {
    updates.push(args);
    return false;
  };
  const app = await appFor(dependencies);

  const response = await post(
    app,
    "/api/options/password",
    {
      oldPassword: "old-password",
      password1: "new-password",
      password2: "new-password",
    },
    { auth: true },
  );

  expect(updates).toEqual([[account.id, account.password, "replacement-hash"]]);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Current password is incorrect.",
  });
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
    return "updated";
  };
  const app = await appFor(dependencies);
  const cookie = { cookie: "sid=admin" };

  const validSort = await get(
    app,
    "/api/admin?sortBy=subscriberCount&order=desc",
    { headers: cookie },
  );
  const invalidSort = await get(
    app,
    "/api/admin?sortBy=id;drop&order=sideways",
    { headers: cookie },
  );
  const invalidUpdate = await post(
    app,
    "/api/admin",
    { newUrl: "javascript:x", oldUrl: "not a url" },
    { headers: cookie },
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

  /* eslint-disable no-await-in-loop -- Module mocks are shared within this test file. */
  for (const testCase of cases) {
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
    const response = await post(
      app,
      "/api/mail",
      {
        from: "sender@example.com",
        raw: relayed("Subject: Test\r\n\r\nBody"),
        to: "reader@example.com",
      },
      {
        headers: testCase.requestSecret
          ? { [mailRelaySecretHeader]: testCase.requestSecret }
          : {},
      },
    );

    expect(response.status).toBe(testCase.expectedStatus);
    expect(handlerCalls).toBe(0);
  }
  /* eslint-enable no-await-in-loop */
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

  const response = await relayMail(app, {
    from: "  sender@example.com  ",
    raw: relayed("Subject: Test\r\n\r\nBody"),
    to: " Reader@Example.com ",
  });

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
    relayMail(app, {
      from: "sender@example.com",
      raw,
      to: "reader@example.com",
    });

  const exact = await mail(relayed("a".repeat(maxRawEmailBytes)));
  const over = await mail(relayed("a".repeat(maxRawEmailBytes + 1)));
  const notBase64 = await mail("Subject: Test\r\n\r\nBody");

  expect(exact.status).toBe(200);
  expect(over.status).not.toBe(200);
  expect(notBase64.status).toBe(422);
  expect(sizes).toEqual([maxRawEmailBytes]);
});

// The relay carries base64 precisely so that an 8-bit body in a legacy
// charset arrives byte for byte; routing it as UTF-8 text replaced every
// such byte with U+FFFD.
test("delivers raw MIME bytes that are not valid UTF-8", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAIL_ENABLED = true;
  dependencies.config.MAIL_RELAY_SECRET = "relay-secret";
  const latin1 = Buffer.from(
    "Subject: caf\u00e9\r\n\r\nR\u00e9sum\u00e9",
    "latin1",
  );
  const received: Buffer[] = [];
  dependencies.emailHandler.processEmail = async (raw) => {
    if (!Buffer.isBuffer(raw)) throw new Error("Expected buffered mail input");
    received.push(raw);
  };
  const app = await appFor(dependencies);

  const response = await relayMail(app, {
    from: "sender@example.com",
    raw: latin1.toString("base64"),
    to: "reader@example.com",
  });

  expect(response.status).toBe(200);
  expect(received).toHaveLength(1);
  expect(received[0]?.equals(latin1)).toBe(true);
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

  const response = await relayMail(app, {
    from: "sender@example.com",
    raw: "Subject: Test\r\n\r\nBody",
  });

  expect(response.status).toBe(422);
  expect(handlerCalls).toBe(0);
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
      name: "Daily",
      parentId: 4,
      pausedUntil: null,
      unreadArticlesCount: 0,
      url: "https://news.test/feed",
    },
    {
      faviconFingerprint: null,
      homeUrl: null,
      id: 2,
      kind: "email",
      name: "A newsletter",
      parentId: null,
      pausedUntil: null,
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
      name: "Beta",
      parentId: 2,
      pausedUntil: null,
      unreadArticlesCount: 0,
      url: "https://b.test/feed",
    },
    {
      faviconFingerprint: null,
      homeUrl: "https://a.test",
      id: 2,
      kind: "feed" as const,
      name: "Aardvark",
      parentId: 2,
      pausedUntil: null,
      unreadArticlesCount: 0,
      url: "https://a.test/feed",
    },
    {
      faviconFingerprint: null,
      homeUrl: "https://c.test",
      id: 3,
      kind: "feed" as const,
      name: "Loose",
      parentId: null,
      pausedUntil: null,
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

test("creates active users without registration integrations", async () => {
  const dependencies = createDependencies();
  let created:
    | Parameters<ServerServices["usersDataService"]["createUser"]>[0]
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
    return "created";
  };
  dependencies.mailSender.sendActivationEmail = async () => {
    mailCalls++;
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/register", {
    email: "active@example.com",
    password: "password",
    passwordConfirm: "password",
    username: "Active user",
  });

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

// With Mailjet configured an existing address gets a notice instead; see
// the account-exists and expired-link tests further down.
test.each(["active", "inactive"] as const)(
  "returns generic success without mutating an existing %s account when mail is off",
  async (status) => {
    const dependencies = createDependencies();
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
      return "created";
    };
    dependencies.usersDataService.updatePassword = async () => {
      calls.push("update-password");
      return true;
    };
    dependencies.usersDataService.activateUser = async () => {
      calls.push("activate");
    };
    dependencies.mailSender.sendActivationEmail = async () => {
      calls.push("send");
    };
    const app = await appFor(dependencies);

    const response = await post(app, "/api/register", {
      email: account.email,
      password: "replacement-password",
      passwordConfirm: "replacement-password",
      username: "Replacement name",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    // The hash a new address would pay for, so the two answer in equal time.
    expect(calls).toEqual(["hash"]);
  },
);

// Registration with mail configured is a way to send a message from this
// instance's domain to an address a stranger chose. ENABLE_REGISTRATION and
// ALLOWED_EMAILS say who may hold an account; neither bounds how many mails
// an open form will emit. Turnstile is the documented answer and this is the
// floor under a deployment that has not set it.
test("stops an open signup form from mailing strangers on demand", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  let mailCalls = 0;
  dependencies.password.hash = async () => "hashed-password";
  dependencies.usersDataService.getUserCount = async () => 1;
  dependencies.usersDataService.findUser = async () => undefined;
  dependencies.usersDataService.createUser = async () => "created";
  dependencies.mailSender.sendActivationEmail = async () => {
    mailCalls++;
  };
  const app = await appFor(dependencies);
  const register = (email: string, address: string) =>
    post(
      app,
      "/api/register",
      {
        email,
        password: "password",
        passwordConfirm: "password",
        username: "Stranger",
      },
      { headers: { "x-forwarded-for": address } },
    );

  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    await register("stranger@example.com", "203.0.113.7");
  }
  expect(mailCalls).toBe(10);

  // The same generic success the route already gives a disposable address or
  // an existing account, so the throttle is not itself an answer about who
  // exists -- but no mail leaves.
  const blocked = await register("stranger@example.com", "203.0.113.7");
  expect(blocked.status).toBe(200);
  expect(await blocked.json()).toEqual({ success: true });
  expect(mailCalls).toBe(10);

  // Keyed on the address too, so spending one address's budget cannot stop
  // anyone else from signing up.
  await register("stranger@example.com", "198.51.100.4");
  expect(mailCalls).toBe(11);
});

// Without mail there is nothing to send, but every attempt still costs a
// password hash, so the form is bounded the same way.
test("throttles registration when email activation is off", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  let hashCalls = 0;
  dependencies.password.hash = async () => {
    hashCalls++;
    return "hashed-password";
  };
  dependencies.usersDataService.getUserCount = async () => 1;
  dependencies.usersDataService.findUser = async () => undefined;
  dependencies.usersDataService.createUser = async () => "created";
  const app = await appFor(dependencies);
  const register = () =>
    post(
      app,
      "/api/register",
      {
        email: "stranger@example.com",
        password: "password",
        passwordConfirm: "password",
        username: "Stranger",
      },
      { headers: { "x-forwarded-for": "203.0.113.7" } },
    );

  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    await register();
  }
  expect(hashCalls).toBe(10);

  const blocked = await register();
  expect(blocked.status).toBe(200);
  expect(await blocked.json()).toEqual({ success: true });
  expect(hashCalls).toBe(10);
});

// A failed account-exists notice answers like a sent one; the failure is
// logged instead of returned.
test("a failed account-exists notice still answers generic success", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  dependencies.usersDataService.findUser = async () => account;
  dependencies.usersDataService.startPasswordReset = async () => {};
  dependencies.mailSender.sendAccountExistsEmail = async () => {
    throw new Error("Mailjet unavailable");
  };
  const app = await appFor(dependencies);
  const logged = spyOn(console, "error").mockImplementation(() => {});

  try {
    const response = await post(app, "/api/register", {
      email: account.email,
      password: "password",
      passwordConfirm: "password",
      username: "Active user",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
});

test("answers a disposable address with generic success and no account", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  let created = 0;
  dependencies.usersDataService.getUserCount = async () => 1;
  dependencies.usersDataService.findUser = async () => undefined;
  dependencies.usersDataService.createUser = async () => {
    created++;
    return "created";
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/register", {
    email: " reader@mailinator.com ",
    password: "password",
    passwordConfirm: "password",
    username: "Stranger",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(created).toBe(0);
});

// A fresh install answers registration regardless of ENABLE_REGISTRATION, and
// answers it identically whether or not it worked. Someone fumbling their way
// into their own empty instance must not be able to lock themselves out of it
// for fifteen minutes with no way to tell that is what happened.
test("never throttles the first operator of an empty instance", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  let mailCalls = 0;
  dependencies.password.hash = async () => "hashed-password";
  dependencies.usersDataService.getUserCount = async () => 0;
  dependencies.usersDataService.findUser = async () => undefined;
  dependencies.usersDataService.createUser = async () => "created";
  dependencies.mailSender.sendActivationEmail = async () => {
    mailCalls++;
  };
  const app = await appFor(dependencies);

  for (let attempt = 0; attempt < 12; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    await post(app, "/api/register", {
      email: "operator@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Operator",
    });
  }
  expect(mailCalls).toBe(12);
});

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
    return "created";
  };
  dependencies.usersDataService.updatePassword = async () => {
    databaseCalls++;
    return true;
  };
  dependencies.usersDataService.activateUser = async () => {
    databaseCalls++;
  };
  const app = await appFor(dependencies);
  const register = (token?: string) =>
    post(app, "/api/register", {
      email: "protected@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Protected user",
      ...(token ? { "cf-turnstile-response": token } : {}),
    });

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
    | Parameters<ServerServices["usersDataService"]["createUser"]>[0]
    | undefined;
  const sent: [string, string][] = [];
  const events: string[] = [];
  dependencies.usersDataService.createUser = async (payload) => {
    events.push("create");
    created = payload;
    return "created";
  };
  dependencies.mailSender.sendActivationEmail = async (email, token) => {
    events.push("send");
    sent.push([email, token]);
  };
  const app = await appFor(dependencies);

  const startedAt = Date.now();
  const response = await post(app, "/api/register", {
    email: "inactive@example.com",
    password: "password",
    passwordConfirm: "password",
    username: "Inactive user",
  });
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
  expect(events).toEqual(["create", "send"]);
});

// Mail goes out only for a committed row, so a failed delivery cannot leave a
// link to a token that was never stored. The row stays, and withdrawing its
// token turns the next registration attempt into an expired-link resend.
test("withdraws the stored activation token when delivery fails", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  const events: string[] = [];
  let stored: string | undefined;
  dependencies.usersDataService.createUser = async (payload) => {
    events.push("create");
    stored = payload.activationToken;
    return "created";
  };
  dependencies.mailSender.sendActivationEmail = async () => {
    events.push("send");
    throw new Error("Mailjet unavailable");
  };
  dependencies.usersDataService.withdrawActivationToken = async (token) => {
    events.push(token === stored ? "withdraw-stored" : "withdraw-other");
  };
  const app = await appFor(dependencies);
  const logged = spyOn(console, "error").mockImplementation(() => {});

  try {
    const response = await post(app, "/api/register", {
      email: "inactive@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Inactive user",
    });

    // Logged, not answered: an existing address whose send fails answers
    // success, so a new one must too.
    expect(response.status).toBe(200);
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
  expect(events).toEqual(["create", "send", "withdraw-stored"]);
});

// A same-address registration that lost the race to the insert gets the
// answer an existing account gets, and a failed insert mails nothing: every
// link sent points at a committed row (#848).
const lostRace: ServerServices["usersDataService"]["createUser"] = async () =>
  "exists";
const failedInsert: ServerServices["usersDataService"]["createUser"] =
  async () => {
    throw new Error("insert failed");
  };
test.each([
  ["lost the insert race", lostRace, 200],
  ["failed to insert", failedInsert, 500],
] as const)(
  "sends no activation mail when the account %s",
  async (_label, createUser, status) => {
    const dependencies = createDependencies();
    dependencies.config.ENABLE_REGISTRATION = true;
    dependencies.config.MAILJET_API_KEY = "mailjet-key";
    dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
    let mailCalls = 0;
    dependencies.usersDataService.createUser = createUser;
    dependencies.mailSender.sendActivationEmail = async () => {
      mailCalls++;
    };
    const app = await appFor(dependencies);

    const response = await post(app, "/api/register", {
      email: "racer@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Racer",
    });

    expect(response.status).toBe(status);
    if (status === 200)
      expect(await response.json()).toEqual({ success: true });
    expect(mailCalls).toBe(0);
  },
);

// The store, not the route's earlier count, has the last word on whether
// registration is open: a request that lost the bootstrap race is refused
// like any other while registration is disabled, and nothing is mailed.
test.each([false, true])(
  "refuses a registration the store closed, with Mailjet=%s",
  async (useMailjet) => {
    const dependencies = createDependencies();
    if (useMailjet) {
      dependencies.config.MAILJET_API_KEY = "mailjet-key";
      dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
    }
    let registrationEnabled: boolean | undefined;
    let mailCalls = 0;
    dependencies.usersDataService.getUserCount = async () => 0;
    dependencies.usersDataService.createUser = async (_payload, enabled) => {
      registrationEnabled = enabled;
      return "closed";
    };
    dependencies.mailSender.sendActivationEmail = async () => {
      mailCalls++;
    };
    const app = await appFor(dependencies);

    const response = await post(app, "/api/register", {
      email: "second@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Second",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Registration is currently disabled",
      success: false,
    });
    expect(registrationEnabled).toBe(false);
    expect(mailCalls).toBe(0);
  },
);

// The recovery path a forgotten password needs, and every way it must refuse
// to say more than it should.
test("resets a password without admitting whether the account exists", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "key";
  dependencies.config.MAILJET_API_SECRET = "secret";
  const target = { ...account, email: "forgetful@example.com" };
  const sent: { email: string; token: string }[] = [];
  const started: { expiresAt: Date; tokenHash: string; userId: number }[] = [];
  dependencies.usersDataService.findUser = async (email) =>
    email === target.email ? target : undefined;
  dependencies.usersDataService.startPasswordReset = async (
    userId,
    tokenHash,
    expiresAt,
  ) => {
    started.push({ expiresAt, tokenHash, userId });
  };
  dependencies.mailSender.sendPasswordResetEmail = async (email, token) => {
    sent.push({ email, token });
  };
  const app = await appFor(dependencies);
  const request = (email: string) =>
    post(app, "/api/password-reset", { email });

  const known = await request(target.email);
  const unknown = await request("nobody@example.com");
  const unknownBody: unknown = await unknown.json();

  expect(known.status).toBe(200);
  expect(unknown.status).toBe(200);
  expect(await known.json()).toEqual(unknownBody);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.email).toBe(target.email);

  // The token travels in the link and only its digest is stored, so a dump of
  // the users table is not a set of working reset links.
  const token = sent[0]!.token;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  expect(started).toHaveLength(1);
  expect(started[0]?.tokenHash).toBe(tokenHash);
  expect(started[0]?.tokenHash).not.toBe(token);
  expect(started[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());

  // The send is deliberately not awaited, so a Mailjet outage cannot make a
  // known address answer differently -- or more slowly -- than an unknown one.
  dependencies.mailSender.sendPasswordResetEmail = async () => {
    throw new Error("Mailjet unavailable");
  };
  const undelivered = await request(target.email);
  expect(undelivered.status).toBe(200);
  expect(await undelivered.json()).toEqual(unknownBody);
});

// The reset form mails an address the caller names, so it is bounded like
// the login form: per (address, account), with the same 200 either way.
test("stops a reset form from mailing one account on demand", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "key";
  dependencies.config.MAILJET_API_SECRET = "secret";
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  const target = { ...account, email: "forgetful@example.com" };
  let sent = 0;
  dependencies.usersDataService.findUser = async () => target;
  dependencies.usersDataService.startPasswordReset = async () => {};
  dependencies.mailSender.sendPasswordResetEmail = async () => {
    sent++;
  };
  const app = await appFor(dependencies);
  const request = (address: string) =>
    post(
      app,
      "/api/password-reset",
      { email: target.email },
      { headers: { "x-forwarded-for": address } },
    );

  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    expect((await request("203.0.113.7")).status).toBe(200);
  }
  const throttled = await request("203.0.113.7");
  const elsewhere = await request("198.51.100.4");

  expect(throttled.status).toBe(200);
  expect(await throttled.json()).toEqual({ success: true });
  expect(elsewhere.status).toBe(200);
  expect(sent).toBe(11);

  // The reset counter is its own scope: tripping it does not lock the same
  // address out of signing in with the right password.
  dependencies.password.verify = async (value, hash) =>
    hash === target.password && value === "password";
  const login = await post(
    app,
    "/api/login",
    { email: target.email, password: "password" },
    { headers: { "x-forwarded-for": "203.0.113.7" } },
  );
  expect(login.status).toBe(200);
});

test("spends a reset token once and refuses an expired one", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "key";
  dependencies.config.MAILJET_API_SECRET = "secret";
  const completed: {
    passwordHash: string;
    tokenHash: string;
    userId: number;
  }[] = [];
  dependencies.usersDataService.findUserByPasswordResetToken = async (
    tokenHash,
  ) => {
    const valid =
      tokenHash === createHash("sha256").update("good").digest("hex");
    return {
      ...account,
      passwordResetTokenExpiresAt: valid
        ? new Date(Date.now() + 60_000)
        : new Date(Date.now() - 60_000),
      passwordResetTokenHash: tokenHash,
    };
  };
  dependencies.usersDataService.completePasswordReset = async (
    userId,
    tokenHash,
    passwordHash,
  ) => {
    completed.push({ passwordHash, tokenHash, userId });
    return true;
  };
  dependencies.password.hash = async (value) => `hashed:${value}`;
  const app = await appFor(dependencies);
  const confirm = (token: string, password1: string, password2 = password1) =>
    post(app, "/api/password-reset/confirm", { password1, password2, token });

  const good = await confirm("good", "a-new-password");
  const expired = await confirm("stale", "a-new-password");
  const mismatched = await confirm("good", "one", "two");

  expect(good.status).toBe(200);
  expect(expired.status).toBe(400);
  expect(mismatched.status).toBe(422);
  expect(completed).toEqual([
    {
      passwordHash: "hashed:a-new-password",
      tokenHash: createHash("sha256").update("good").digest("hex"),
      userId: account.id,
    },
  ]);
});

// The spend must be part of the write itself (#809): a double that answers
// false stands in for the transaction losing the race, and the route has to
// answer the loser with the same refusal an unknown token gets.
test("a confirmation that loses the race for its link is refused", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.findUserByPasswordResetToken = async (
    tokenHash,
  ) => ({
    ...account,
    passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
    passwordResetTokenHash: tokenHash,
  });
  dependencies.usersDataService.completePasswordReset = async () => false;
  dependencies.password.hash = async (value) => `hashed:${value}`;
  const app = await appFor(dependencies);

  const rejected = await post(app, "/api/password-reset/confirm", {
    password1: "one",
    password2: "one",
    token: "t",
  });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({
    error: "This reset link is no longer valid.",
  });
});

test("has no reset flow at all when outgoing mail is not configured", async () => {
  const dependencies = createDependencies();
  let sends = 0;
  dependencies.usersDataService.findUser = async () => account;
  dependencies.mailSender.sendPasswordResetEmail = async () => {
    sends++;
  };
  const app = await appFor(dependencies);

  const info = await get(app, "/api/register");
  const requested = await post(app, "/api/password-reset", {
    email: account.email,
  });
  const confirmed = await post(app, "/api/password-reset/confirm", {
    password1: "x",
    password2: "x",
    token: "anything",
  });

  // The login view hides the link on this flag, and the request route still
  // answers exactly as it does for an account that does not exist.
  expect(await info.json()).toMatchObject({ passwordResetEnabled: false });
  expect(requested.status).toBe(200);
  expect(confirmed.status).toBe(400);
  expect(sends).toBe(0);
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

  const valid = await post(app, "/api/activate/valid", undefined);
  const expired = await post(app, "/api/activate/expired", undefined);
  const blank = await post(app, "/api/activate/%20%20", undefined);

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

// Re-registering over a half-made account used to be a silent no-op, which
// left an expired activation link with no way back in (#810). The route
// still answers success either way -- the mailbox is what changes.
test("registering an address with an expired link sends a fresh one", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  const refreshed: { expiresAt: Date; token: string; userId: number }[] = [];
  const activationSends: string[] = [];
  dependencies.usersDataService.findUser = async (email) => ({
    ...account,
    activationToken: "old-token",
    activationTokenExpiresAt: new Date(Date.now() - 60_000),
    email,
    status: "inactive" as const,
  });
  dependencies.usersDataService.refreshActivationToken = async (
    userId,
    token,
    expiresAt,
  ) => {
    refreshed.push({ expiresAt, token, userId });
    return true;
  };
  dependencies.mailSender.sendActivationEmail = async (email) => {
    activationSends.push(email);
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/register", {
    email: "pending@example.com",
    password: "password",
    passwordConfirm: "password",
    username: "Pending user",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(activationSends).toEqual(["pending@example.com"]);
  expect(refreshed).toHaveLength(1);
  expect(refreshed[0]!.userId).toBe(account.id);
  // A fresh link promises a day, like the first one did.
  expect(refreshed[0]!.expiresAt.getTime()).toBeGreaterThan(
    Date.now() + 23 * 60 * 60 * 1_000,
  );
});

// A replacement link whose mail failed is withdrawn, so the next attempt
// sends another at once instead of finding an unexpired token and staying
// silent for a day (#849). A recovery that stored nothing sends nothing.
test("a failed replacement activation mail is retried on the next attempt", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  // An object, so the closures' writes are not narrowed away at the reads.
  const row: { token: null | string } = { token: null };
  let mailUp = false;
  const delivered: (null | string)[] = [];
  dependencies.usersDataService.findUser = async (email) => ({
    ...account,
    activationToken: row.token,
    activationTokenExpiresAt: row.token ? new Date(Date.now() + 60_000) : null,
    email,
    status: "inactive" as const,
  });
  dependencies.usersDataService.refreshActivationToken = async (
    _userId,
    token,
  ) => {
    if (row.token) return false;
    row.token = token;
    return true;
  };
  dependencies.usersDataService.withdrawActivationToken = async (token) => {
    if (row.token === token) row.token = null;
  };
  dependencies.mailSender.sendActivationEmail = async (_email, token) => {
    if (!mailUp) throw new Error("Mailjet unavailable");
    delivered.push(token);
  };
  const app = await appFor(dependencies);
  const register = () =>
    post(app, "/api/register", {
      email: "pending@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Pending user",
    });

  // The same answer as a delivered mail: a 500 here and not for an unknown
  // address would say which addresses hold accounts.
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const failed = await register();
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ success: true });
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
  expect(row.token).toBeNull();

  mailUp = true;
  const retried = await register();
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual({ success: true });
  expect(delivered).toEqual([row.token]);

  // The delivered link is live now, so a further attempt stores and sends
  // nothing and still answers the generic success.
  const again = await register();
  expect(await again.json()).toEqual({ success: true });
  expect(delivered).toHaveLength(1);
});

// An active account is not a half-made one, so no new activation -- the
// notice carries a reset link instead, the way in that never assumes the
// password still works.
test("registering an active address sends the account-exists reset notice", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  const resets: { expiresAt: Date; tokenHash: string; userId: number }[] = [];
  const notices: string[] = [];
  dependencies.usersDataService.findUser = async (email) => ({
    ...account,
    email,
  });
  dependencies.usersDataService.startPasswordReset = async (
    userId,
    tokenHash,
    expiresAt,
  ) => {
    resets.push({ expiresAt, tokenHash, userId });
  };
  dependencies.mailSender.sendAccountExistsEmail = async (email) => {
    notices.push(email);
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/register", {
    email: "active@example.com",
    password: "password",
    passwordConfirm: "password",
    username: "Active user",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(notices).toEqual(["active@example.com"]);
  expect(resets).toHaveLength(1);
  expect(resets[0]!.userId).toBe(account.id);
  expect(resets[0]!.expiresAt.getTime()).toBeGreaterThan(
    Date.now() + 55 * 60_000,
  );
  // Only the digest is stored, never the token itself.
  expect(resets[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
});

// Every route in the admin group, not just the one that used to be checked
// here. The guard is the group's now rather than each handler's, so this is
// what stops a route added there from being reachable by anyone signed in.
const adminOnlyRequests = [
  ["GET", "/api/admin", undefined],
  [
    "POST",
    "/api/admin",
    { newUrl: "https://b.test/", oldUrl: "https://a.test/" },
  ],
  ["DELETE", "/api/admin", { removeSourceId: 1 }],
  ["GET", "/api/admin/redirects", undefined],
  ["DELETE", "/api/admin/redirects", { oldUrl: "https://a.test/" }],
] as const;

test("allows admin sessions and rejects non-admin sessions", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.getUserBySid = async (sid) => ({
    ...sessionUser,
    isAdmin: sid === "admin",
  });
  const app = await appFor(dependencies);
  const call = (
    [method, path, body]: (typeof adminOnlyRequests)[number],
    sid: string,
  ) => send(app, method, path, body, { headers: { cookie: `sid=${sid}` } });

  const reader = await Promise.all(
    adminOnlyRequests.map((request) => call(request, "reader")),
  );
  const anonymous = await Promise.all(
    adminOnlyRequests.map((request) => call(request, "")),
  );
  const listing = await call(adminOnlyRequests[0], "admin");

  expect(reader.map((response) => response.status)).toEqual(
    adminOnlyRequests.map(() => 403),
  );
  expect(anonymous.map((response) => response.status)).toEqual(
    adminOnlyRequests.map(() => 401),
  );
  expect(listing.status).toBe(200);
});

// Revocation is scoped by the signed-in user, never by anything the request
// names; sessions-integration covers that the data service honours the scope.
test("any signed-in user can revoke one of their sessions or all the others", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.getUserBySid = async () => ({
    ...sessionUser,
    isAdmin: false,
  });
  const revoked: unknown[][] = [];
  dependencies.usersDataService.deleteSessionById = async (...args) => {
    revoked.push(["one", ...args]);
  };
  dependencies.usersDataService.deleteOtherSessions = async (...args) => {
    revoked.push(["others", ...args]);
  };
  const app = await appFor(dependencies);

  const listing = await get(app, "/api/options/sessions", { auth: true });
  const one = await send(app, "DELETE", "/api/options/sessions/7", undefined, {
    auth: true,
  });
  const malformed = await send(
    app,
    "DELETE",
    "/api/options/sessions/seven",
    undefined,
    { auth: true },
  );
  const others = await send(app, "DELETE", "/api/options/sessions", undefined, {
    auth: true,
  });

  expect(listing.status).toBe(200);
  expect([one.status, malformed.status, others.status]).toEqual([
    200, 400, 200,
  ]);
  expect(revoked).toEqual([
    ["one", sessionUser.id, 7],
    ["others", sessionUser.id, "test"],
  ]);
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

test("logs a slow request with its route pattern, never the raw query string", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  // A tiny threshold stands in for an artificially slow handler: every
  // request that completes at all is "slow" against it.
  dependencies.config.SLOW_REQUEST_MS = 0;
  dependencies.sourcesDataService.getFavicon = async () =>
    "data:image/png;base64,AAAA";
  const app = await appFor(dependencies);
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    const response = await get(app, "/api/favicon/7?v=abc123", { auth: true });

    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const line: unknown = log.mock.calls[0]?.[0];
    if (typeof line !== "string") throw new Error("Expected a logged line");
    expect(line).toMatch(/^GET \/api\/favicon\/:id 200 \d+$/);
    expect(line).not.toContain("v=abc123");
    expect(line).not.toContain("?");
    expect(line).not.toContain("/7");
  } finally {
    log.mockRestore();
  }
});

test("a request under the threshold logs nothing", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const app = await appFor(dependencies);
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    const response = await get(app, "/api/session", { auth: true });

    expect(response.status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

// The internal healthcheck runs constantly and carries no useful signal, so
// it stays out of the slow-request log even when it is the slowest thing an
// instance ever serves.
test("never logs the healthcheck route, however slow", async () => {
  const dependencies = createDependencies();
  dependencies.config.SLOW_REQUEST_MS = 0;
  const app = await appFor(dependencies);
  app.listen(0);
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    const origin = `http://127.0.0.1:${app.server?.port}`;
    const response = await fetch(`${origin}/healthcheck`);

    expect(response.status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    await app.stop();
  }
});

test("cache headers: /assets/* is immutable, index.html is no-cache", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "feedfathom-spa-"));
  try {
    // Create directory structure with files
    await Bun.write(`${tmpDir}/index.html`, "<html>test</html>");
    await Bun.write(`${tmpDir}/assets/x-abc123.js`, "console.log('test');");

    const appWithSpa = await createServerApp(createDependencies(), {
      production: true,
      spaDirectory: tmpDir,
    });

    // Test /assets/* → immutable
    const assetResponse = await get(appWithSpa, "/assets/x-abc123.js");
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );

    // Test / → no-cache
    const indexResponse = await get(appWithSpa, "/");
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("Cache-Control")).toBe("no-cache");

    // Test /index.html → no-cache
    const indexHtmlResponse = await get(appWithSpa, "/index.html");
    expect(indexHtmlResponse.status).toBe(200);
    expect(indexHtmlResponse.headers.get("Cache-Control")).toBe("no-cache");

    // Test SPA fallback (404 with Accept: text/html returns index.html) → no-cache
    const spaFallbackResponse = await get(appWithSpa, "/some/spa/route", {
      headers: { accept: "text/html" },
    });
    expect(spaFallbackResponse.status).toBe(200);
    expect(spaFallbackResponse.headers.get("Cache-Control")).toBe("no-cache");
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

// #991: one shared subscriber fans out to every stream, and each stream
// forwards only the sources its user subscribes to.
test("the event stream forwards only the user's sources and unlistens on cancel", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  let deliver: ((channel: string, message: string) => void) | undefined;
  let connections = 0;
  const subscriber: ArticleEventSubscriber = {
    disconnect: () => {},
    on: (_event, listener) => {
      deliver = listener;
    },
    subscribe: async () => 1,
  };
  const hub = new ArticleEventHub(() => {
    connections++;
    return subscriber;
  });
  let unlistened = 0;
  dependencies.articleEventHub = strictFake<ArticleEventHub>({
    close: () => hub.close(),
    listen: (listener) => {
      const off = hub.listen(listener);
      return () => {
        unlistened++;
        off();
      };
    },
  });
  dependencies.userSourcesDataService.getUserSourceIds = async (userId) =>
    userId === sessionUser.id ? [3] : [];
  const app = await appFor(dependencies);
  const open = async () => await get(app, "/api/events", { auth: true });

  const first = await open();
  const second = await open();
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("text/event-stream");
  expect(first.headers.get("cache-control")).toBe("no-cache");
  expect(first.headers.get("x-accel-buffering")).toBe("no");
  const reader = first.body!.getReader();
  const decoder = new TextDecoder();
  const next = async () => decoder.decode((await reader.read()).value);
  expect(await next()).toContain(": connected");
  expect(connections).toBe(1);

  deliver?.("another-channel", JSON.stringify({ count: 1, sourceId: 3 }));
  deliver?.(articleEventsChannel, "not json");
  deliver?.(articleEventsChannel, JSON.stringify({ count: 2, sourceId: 4 }));
  deliver?.(articleEventsChannel, JSON.stringify({ count: 5, sourceId: 3 }));
  expect(await next()).toBe('data: {"count":5,"sourceId":3}\n\n');

  await reader.cancel();
  expect(unlistened).toBe(1);
  await second.body!.cancel();
  expect(unlistened).toBe(2);
});

test("a client gone during the source lookup leaves no listener behind", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const controller = new AbortController();
  dependencies.userSourcesDataService.getUserSourceIds = async () => {
    controller.abort();
    return [3];
  };
  let listening = 0;
  dependencies.articleEventHub = strictFake<ArticleEventHub>({
    close: () => {},
    listen: () => {
      listening++;
      return () => {
        listening--;
      };
    },
  });
  const app = await appFor(dependencies);
  await app.handle(
    new Request("http://localhost/api/events", {
      headers: { cookie: "sid=test" },
      signal: controller.signal,
    }),
  );

  expect(listening).toBe(0);
});

test("closing the hub ends open event streams", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const hub = new ArticleEventHub(() => ({
    disconnect: () => {},
    on: () => {},
    subscribe: async () => 1,
  }));
  dependencies.articleEventHub = hub;
  const app = await appFor(dependencies);
  const response = await get(app, "/api/events", { auth: true });
  const reader = response.body!.getReader();
  await reader.read();

  hub.close();
  expect((await reader.read()).done).toBe(true);

  // A stream that registers after shutdown began ends rather than resubscribe.
  const late = await get(app, "/api/events", { auth: true });
  const lateReader = late.body!.getReader();
  await lateReader.read();
  expect((await lateReader.read()).done).toBe(true);
});

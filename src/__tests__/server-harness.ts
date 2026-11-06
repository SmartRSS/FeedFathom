import type { AppConfig } from "#platform/config.ts";
import type { RedirectMap } from "#features/feeds/redirect-map.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { type EmailHandler } from "#features/mail-ingest/email-handler.ts";
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
import type { ArticleEventHub } from "#features/reader/article-event-hub.ts";
import { ArticleImporter } from "#features/feeds/article-import.ts";
import { resolve } from "node:path";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { AuthThrottle } from "#features/auth/auth-throttle.ts";
import { createFakeThrottleRedis } from "#features/auth/__tests__/fake-throttle-redis.ts";
import { createServerApp, type ServerServices } from "../server-app.ts";

const spaDirectory = resolve(import.meta.dir, "../spa");

export const runLease: UserSourcesDataService["withSubscriptionInitializationLease"] =
  async (_subscriptionId, work) => ({
    outcome: "claimed",
    result: await work(),
  });

export const sessionUser = {
  email: "reader@example.com",
  id: 42,
  isAdmin: false,
  name: "Reader",
  status: "active" as const,
};

export const account = {
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
export type Dependencies = {
  -readonly [Key in keyof ServerServices]: ServerServices[Key];
};

// One request through the whole composed app, so a route test also covers the
// error mapping, the session plugin and the body cap it runs behind.

// Every service a request can reach, each a strict fake: the defaults below
// answer the reads most routes make on the way in, and anything else a test
// has not arranged throws and names itself.
export function createDependencies(): Dependencies {
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
    production: false,
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
      async activate() {
        return false;
      },
      async authenticate() {
        return undefined;
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
      async findUserByPasswordResetToken() {
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
          return { failure: "" };
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

export const appFor = async (
  dependencies: Dependencies,
  production = false,
) => {
  dependencies.config.production = production;
  return await createServerApp(dependencies, { spaDirectory });
};

export type App = Awaited<ReturnType<typeof appFor>>;

export type RequestOptions = {
  // Sends the session cookie a test's authenticate answers for.
  auth?: boolean;
  headers?: Record<string, string>;
  origin?: string;
};

// One request through the whole app. A body is sent as JSON.
export const send = (
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

export const get = (app: App, path: string, options?: RequestOptions) =>
  send(app, "GET", path, undefined, options);

export const post = (
  app: App,
  path: string,
  body?: unknown,
  options?: RequestOptions,
) => send(app, "POST", path, body, options);

export const authenticated = (dependencies: Dependencies) => {
  dependencies.usersDataService.authenticate = async () => sessionUser;
};

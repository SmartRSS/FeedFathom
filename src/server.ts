import { config } from "#platform/config.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import { RedirectMap } from "#platform/http/redirect-map.ts";
import { AuthThrottle } from "#features/auth/auth-throttle.ts";
import { MailSender } from "#features/auth/mail-sender.ts";
import { UsersDataService } from "#features/auth/user-data-service.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { FaviconStore } from "#features/feeds/favicon-store.ts";
import { FeedParser } from "#features/feeds/feed-parser.ts";
import { FeedPreviewCache } from "#features/feeds/feed-preview-cache.ts";
import { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import { OpmlImportService } from "#features/feeds/opml-import-service.ts";
import { OpmlParser } from "#features/feeds/opml-parser.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import { EmailHandler } from "#features/mail-ingest/email-handler.ts";
import { createFeedRuntime } from "./runtime.ts";
import { createServerApp } from "./server-app.ts";

const runtime = await createFeedRuntime();
const { drizzleConnection, httpClient, redis } = runtime;
const production = Bun.env.NODE_ENV === "production";

const articlesDataService = new ArticlesDataService(drizzleConnection);
const foldersDataService = new FoldersDataService(drizzleConnection);
const sourcesDataService = new SourcesDataService(drizzleConnection);
const websubStateService = new WebSubStateService(drizzleConnection);
const userSourcesDataService = new UserSourcesDataService(
  drizzleConnection,
  foldersDataService,
  sourcesDataService,
);
const sourceEnqueuer = new SourceEnqueuer(runtime.bullmqQueue);
const redirectMap = new RedirectMap(redis);

export const app = await createServerApp(
  {
    articlesDataService,
    authThrottle: new AuthThrottle(redis),
    config,
    emailHandler: new EmailHandler(
      sourcesDataService,
      articlesDataService,
      userSourcesDataService,
    ),
    faviconStore: new FaviconStore(drizzleConnection),
    feedParser: new FeedParser(
      articlesDataService,
      httpClient,
      sourcesDataService,
      websubStateService,
      redirectMap,
      userSourcesDataService,
      config.FEED_FATHOM_DOMAIN,
    ),
    feedPreviewCache: new FeedPreviewCache(redis),
    fetcher: fetch,
    foldersDataService,
    httpClient,
    mailEnabled: config.MAIL_ENABLED,
    mailSender: new MailSender(config),
    opmlImportService: new OpmlImportService(drizzleConnection, sourceEnqueuer),
    opmlParser: new OpmlParser(),
    password: Bun.password,
    redirectMap,
    sourceEnqueuer,
    sourcesDataService,
    userSourcesDataService,
    usersDataService: new UsersDataService(drizzleConnection),
    websubStateService,
  },
  { production },
);

// Unlike the worker, which reports healthy while it waits because nothing
// routes to it, the server must not accept traffic against a schema it was
// not built for -- that would answer requests with errors instead of making
// the orchestrator wait. So it does not listen at all until its migration is
// applied, and the healthcheck's start_period is what covers that gap. A
// migration slower than that budget leaves the server restarting until it
// finishes, which is noisy but self-correcting.
await waitForMigration(drizzleConnection.$client);

app.listen(config.PORT ?? 3000);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () =>
  (shutdownPromise ??= Promise.resolve(app.stop())
    .then(() => runtime.close())
    .then(() => undefined));
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

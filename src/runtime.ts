import { Queue } from "bullmq";
import { RedisClient } from "bun";
import Redis from "ioredis";
import { config } from "#platform/config.ts";
import { createPooledDrizzleConnection } from "#platform/db/connection.ts";
import { cleanupOrphanedData } from "#platform/db/maintenance.ts";
import { HttpClient } from "#platform/http/http-client.ts";
import { RedirectMap } from "#platform/http/redirect-map.ts";
import { UsersDataService } from "#features/auth/user-data-service.ts";
import { FeedParser } from "#features/feeds/feed-parser.ts";
import { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";
import { OpmlImportService } from "#features/feeds/opml-import-service.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { JobFailuresDataService } from "#features/admin/job-failure-data-service.ts";

export async function createFeedRuntime() {
  const redis = new RedisClient("redis://redis:6379", {
    autoReconnect: true,
    connectionTimeout: 60 * 60 * 1_000,
    enableAutoPipelining: false,
    enableOfflineQueue: true,
    idleTimeout: 0,
    maxRetries: 100,
    tls: false,
  });
  await redis.connect();

  const bullmqRedis = new Redis({
    host: "redis",
    maxRetriesPerRequest: null,
    port: 6379,
  });
  const bullmqQueue = new Queue("tasks", { connection: bullmqRedis });
  const drizzleConnection = createPooledDrizzleConnection(
    config.DATABASE_URL,
    config.DB_POOL_MAX,
  );
  const articlesDataService = new ArticlesDataService(drizzleConnection);
  const foldersDataService = new FoldersDataService(drizzleConnection);
  const sourcesDataService = new SourcesDataService(
    drizzleConnection,
    bullmqQueue,
  );
  const usersDataService = new UsersDataService(drizzleConnection);
  const jobFailuresDataService = new JobFailuresDataService(drizzleConnection);
  const userSourcesDataService = new UserSourcesDataService(
    drizzleConnection,
    foldersDataService,
    sourcesDataService,
  );
  const opmlImportService = new OpmlImportService(
    drizzleConnection,
    sourcesDataService,
  );
  const httpClient = new HttpClient(redis, {
    instance: config.FEED_FATHOM_DOMAIN,
    version: config.FEEDFATHOM_BUILD,
  });
  const redirectMap = new RedirectMap(redis);
  const feedParser = new FeedParser(
    articlesDataService,
    httpClient,
    sourcesDataService,
    redirectMap,
    userSourcesDataService,
    config.FEED_FATHOM_DOMAIN,
  );
  const faviconRefresher = new FaviconRefresher(httpClient, sourcesDataService);
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= Promise.allSettled([
      bullmqQueue.close(),
      bullmqRedis.quit(),
      redis.close(),
      drizzleConnection.$client.close(),
    ]).then(() => undefined));

  return {
    articlesDataService,
    bullmqQueue,
    bullmqRedis,
    cleanupOrphanedData: () =>
      cleanupOrphanedData(
        drizzleConnection,
        config.USER_DORMANT_AFTER_DAYS,
        config.ARTICLE_STALE_AFTER_DAYS,
        config.USER_EXPIRY_DAYS,
      ),
    close,
    drizzleConnection,
    faviconRefresher,
    feedParser,
    foldersDataService,
    httpClient,
    jobFailuresDataService,
    opmlImportService,
    redirectMap,
    redis,
    sourcesDataService,
    userSourcesDataService,
    usersDataService,
  };
}

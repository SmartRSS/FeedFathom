import { Queue } from "bullmq";
import { RedisClient } from "bun";
import Redis from "ioredis";
import { config } from "#platform/config.ts";
import { createPooledDrizzleConnection } from "./db/connection.ts";
import { ArticlesDataService } from "./db/data-services/article-data-service.ts";
import { FoldersDataService } from "./db/data-services/folder-data-service.ts";
import { JobFailuresDataService } from "./db/data-services/job-failure-data-service.ts";
import { OpmlImportService } from "./db/data-services/opml-import-service.ts";
import { SourcesDataService } from "./db/data-services/source-data-service.ts";
import { UsersDataService } from "./db/data-services/user-data-service.ts";
import { UserSourcesDataService } from "./db/data-services/user-source-data-service.ts";
import { cleanupOrphanedData } from "./db/maintenance.ts";
import { FeedParser } from "./lib/feed-parser.ts";
import { HttpClient } from "./lib/http-client.ts";
import { RedirectMap } from "./lib/redirect-map.ts";

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

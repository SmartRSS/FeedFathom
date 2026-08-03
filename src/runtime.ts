import { Queue } from "bullmq";
import { RedisClient } from "bun";
import Redis from "ioredis";
import { config } from "./config.ts";
import { createDrizzleConnection } from "./db/connection.ts";
import { ArticlesDataService } from "./db/data-services/article-data-service.ts";
import { FoldersDataService } from "./db/data-services/folder-data-service.ts";
import { SourcesDataService } from "./db/data-services/source-data-service.ts";
import { UsersDataService } from "./db/data-services/user-data-service.ts";
import { UserSourcesDataService } from "./db/data-services/user-source-data-service.ts";
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
  const drizzleConnection = createDrizzleConnection(config.DATABASE_URL);
  const articlesDataService = new ArticlesDataService(drizzleConnection);
  const foldersDataService = new FoldersDataService(drizzleConnection);
  const sourcesDataService = new SourcesDataService(
    drizzleConnection,
    bullmqQueue,
  );
  const usersDataService = new UsersDataService(drizzleConnection);
  const userSourcesDataService = new UserSourcesDataService(
    drizzleConnection,
    foldersDataService,
    sourcesDataService,
  );
  const httpClient = new HttpClient(redis);
  const redirectMap = new RedirectMap(redis);
  const feedParser = new FeedParser(
    articlesDataService,
    httpClient,
    sourcesDataService,
    redirectMap,
    userSourcesDataService,
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
    close,
    drizzleConnection,
    feedParser,
    foldersDataService,
    httpClient,
    redirectMap,
    redis,
    sourcesDataService,
    usersDataService,
    userSourcesDataService,
  };
}

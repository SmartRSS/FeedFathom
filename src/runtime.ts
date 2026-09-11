import { Queue } from "bullmq";
import { RedisClient } from "bun";
import Redis from "ioredis";
import { config } from "#platform/config.ts";
import { createPooledDrizzleConnection } from "#platform/db/connection.ts";
import { HttpClient } from "#platform/http/http-client.ts";

// Only what varies per deployment -- connections, the queue and the outbound
// HTTP client -- is built here. Services are built by the entrypoint that uses
// them, so the server bundle carries no worker-only code and the reverse.
export async function createFeedRuntime() {
  const redis = new RedisClient(config.REDIS_URL, {
    autoReconnect: true,
    connectionTimeout: 60 * 60 * 1_000,
    enableAutoPipelining: false,
    enableOfflineQueue: true,
    idleTimeout: 0,
    maxRetries: 100,
    tls: false,
  });
  await redis.connect();

  // BullMQ requires maxRetriesPerRequest: null, so this connection is
  // configured rather than handed the URL alone.
  const bullmqRedis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  const bullmqQueue = new Queue("tasks", { connection: bullmqRedis });
  const drizzleConnection = createPooledDrizzleConnection(
    config.DATABASE_URL,
    config.DB_POOL_MAX,
  );
  const httpClient = new HttpClient(redis, {
    instance: config.FEED_FATHOM_DOMAIN,
    version: config.FEEDFATHOM_BUILD,
  });
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= Promise.allSettled([
      bullmqQueue.close(),
      bullmqRedis.quit(),
      redis.close(),
      drizzleConnection.$client.close(),
    ]).then(() => undefined));

  return {
    bullmqQueue,
    bullmqRedis,
    close,
    drizzleConnection,
    httpClient,
    redis,
  };
}

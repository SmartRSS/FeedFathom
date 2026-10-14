import { Queue } from "bullmq";
import { RedisClient } from "bun";
import Redis from "ioredis";
import { config } from "#platform/config.ts";
import { createPooledDrizzleConnection } from "#platform/db/connection.ts";
import { HttpClient } from "#platform/http/http-client.ts";

// Once maxRetries runs out, Bun closes the client for good: every later
// command fails with "Connection has failed", even after Redis returns. Bun's
// backoff caps at about 2s, so 100 retries outlast only a ~3-minute outage, and
// past that, login and every outbound fetch fail until something restarts the
// process. Nothing would: the healthchecks don't touch Redis. The largest
// value Bun accepts (u32) makes it retry forever, like the ioredis connections.
const redis = new RedisClient(config.REDIS_URL, {
  autoReconnect: true,
  connectionTimeout: 60 * 60 * 1_000,
  enableAutoPipelining: false,
  enableOfflineQueue: true,
  idleTimeout: 0,
  maxRetries: 2 ** 32 - 1,
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

export {
  bullmqQueue,
  bullmqRedis,
  close,
  drizzleConnection,
  httpClient,
  redis,
};
export const fetcher = fetch;
export const password = Bun.password;

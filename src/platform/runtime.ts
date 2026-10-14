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
//
// A connect attempt that times out is the exception: Bun then closes the
// client for good, whatever maxRetries says, and runs onclose. A partition or
// a vanished host drops packets rather than refusing them, so its reconnect
// attempts end in that timeout. onclose reconnects, a second later so a client
// that fails at once cannot spin, and that is what keeps the per-attempt
// timeout short: without it, only a timeout that outlasts the outage would
// keep the client alive, and one attempt could hang that long.
const redis = new RedisClient(config.REDIS_URL, {
  autoReconnect: true,
  connectionTimeout: 10_000,
  enableAutoPipelining: false,
  enableOfflineQueue: true,
  idleTimeout: 0,
  maxRetries: 2 ** 32 - 1,
  tls: false,
});
let closing = false;
// eslint-disable-next-line unicorn/prefer-add-event-listener -- RedisClient has only onclose.
redis.onclose = () => {
  setTimeout(() => {
    if (!closing) redis.connect().catch(() => {});
  }, 1_000).unref();
};
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
// QUIT waits for Redis to answer. When an outage drops packets rather than
// refusing them, that answer never comes, and the open socket held shutdown
// until the orchestrator killed the process. Past this bound the connection
// is dropped instead; whatever is still queued on it could not reach Redis
// anyway.
const redisQuitTimeout = 5_000;
let closePromise: Promise<void> | undefined;
const close = () => {
  closing = true;
  return (closePromise ??= Promise.allSettled([
    bullmqQueue.close(),
    Promise.race([
      bullmqRedis.quit(),
      new Promise((resolve) => setTimeout(resolve, redisQuitTimeout).unref()),
    ]).finally(() => bullmqRedis.disconnect()),
    redis.close(),
    drizzleConnection.$client.close(),
  ]).then(() => undefined));
};

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

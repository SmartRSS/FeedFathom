import { Queue, QueueEvents } from "bullmq";
import { RedisClient } from "bun";
import Redis from "ioredis";
import { config } from "#platform/config.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { HttpClient } from "#platform/http/http-client.ts";
import { UserEventPublisher } from "#platform/user-events.ts";
import { WorkerJobs } from "#platform/worker-jobs.ts";
import {
  WorkerRequests,
  workerRequestEventsMaxLength,
  workerRequestQueueName,
} from "#platform/worker-requests.ts";

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

export const jobQueueName = "tasks";

const bullmqRedis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});
const bullmqQueue = new Queue(jobQueueName, { connection: bullmqRedis });
const workerJobs = new WorkerJobs(bullmqQueue);
const createSubscriber = () =>
  new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const workerRequestQueue = new Queue(workerRequestQueueName, {
  connection: bullmqRedis,
  streams: { events: { maxLen: workerRequestEventsMaxLength } },
});
let workerRequestEvents: { connection: Redis; events: QueueEvents } | undefined;
const openWorkerRequestEvents = () => {
  const connection = createSubscriber();
  const events = new QueueEvents(workerRequestQueueName, { connection });
  events.on("error", (error) => {
    console.error("Worker request events failed:", error);
  });
  return { connection, events };
};
const workerRequests = new WorkerRequests(
  workerRequestQueue,
  () => (workerRequestEvents ??= openWorkerRequestEvents()).events,
  bullmqRedis,
);
const closeWorkerRequestEvents = async () => {
  if (!workerRequestEvents) return;
  await workerRequestEvents.events.close();
  workerRequestEvents.connection.disconnect();
};
const drizzleConnection = createDrizzleConnection(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
});
const httpClient = new HttpClient(redis, {
  instance: config.FEED_FATHOM_DOMAIN,
  version: config.FEEDFATHOM_BUILD,
});
const userEventPublisher = new UserEventPublisher(redis);
const redisQuitTimeout = 5_000;
let closePromise: Promise<void> | undefined;
const close = () => {
  closing = true;
  return (closePromise ??= Promise.allSettled([
    bullmqQueue.close(),
    workerRequestQueue.close(),
    closeWorkerRequestEvents(),
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
  createSubscriber,
  drizzleConnection,
  httpClient,
  redis,
  userEventPublisher,
  workerJobs,
  workerRequests,
};
// oxlint-disable-next-line no-restricted-globals -- fetcher reaches fixed provider APIs such as Mailjet, never a feed host.
const providerFetch = fetch;
export const fetcher: (
  ...args: Parameters<typeof providerFetch>
) => ReturnType<typeof providerFetch> = providerFetch;
export const password: {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
} = Bun.password;

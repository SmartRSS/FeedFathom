import type { AppConfig } from "#platform/config.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { afterAll, expect, test } from "bun:test";
import { Queue, QueueEvents, Worker } from "bullmq";
import Redis from "ioredis";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { HttpDeadlineError } from "#platform/http/request-deadline.ts";
import {
  workerRequestEventsMaxLength,
  WorkerRequests,
} from "#platform/worker-requests.ts";
import { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { MainWorker, type MainWorkerServices } from "#features/jobs/main.ts";

const redisUrl = requireDisposableRedisUrl();
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const eventsConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const suffix = crypto.randomUUID();
const taskQueue = new Queue(`tasks-test-${suffix}`, { connection });
const requestQueueName = `requests-test-${suffix}`;
const requestQueue = new Queue(requestQueueName, {
  connection,
  streams: { events: { maxLen: workerRequestEventsMaxLength } },
});
const requestEvents = new QueueEvents(requestQueueName, {
  connection: eventsConnection,
});

afterAll(async () => {
  await Promise.all([
    taskQueue.obliterate({ force: true }),
    requestQueue.obliterate({ force: true }),
  ]);
  await requestEvents.close();
  await Promise.all([taskQueue.close(), requestQueue.close()]);
  await Promise.all([
    connection.quit(),
    workerConnection.quit(),
    eventsConnection.quit(),
  ]);
});

const source = {
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  favicon: null,
  homeUrl: "https://example.com",
  id: 1 + Math.floor(Math.random() * 2_000_000_000),
  kind: "feed" as const,
  lastAttempt: null,
  lastFetchTrigger: null,
  lastSuccess: null,
  recentFailureDetails: "",
  recentFailures: 0,
  reservedBy: null,
  subscriberCount: 1,
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
  url: "https://example.com/feed",
  websubCallbackToken: null,
  websubHubUrl: null,
  websubLeaseExpiresAt: null,
  websubSecret: null,
  websubStatus: "none" as const,
  websubSubscribeAttemptedAt: null,
  websubTopicUrl: null,
};

const config = strictFake<AppConfig>({
  CLEANUP_INTERVAL: 20,
  GATHER_JOBS_INTERVAL: 30,
  LOCK_DURATION: 30,
  WORKER_CONCURRENCY: 1,
});

test("the worker answers requests on their own queue while every parse slot is busy", async () => {
  const { promise: parsing, resolve: parseStarted } =
    Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const retryAt = Date.now() + 30_000;
  const mainWorker = new MainWorker({
    bullmqQueue: { async upsertJobScheduler() {} },
    config,
    createRequestWorker: (processor, options) =>
      new Worker(requestQueueName, processor, {
        ...options,
        connection: workerConnection,
      }),
    createWorker: (processor, options) =>
      new Worker(taskQueue.name, processor, {
        ...options,
        connection: workerConnection,
      }),
    faviconRefresher: strictFake<MainWorkerServices["faviconRefresher"]>({}),
    feedParser: strictFake<FeedParser>({
      async parseSource() {
        parseStarted();
        await released;
      },
    }),
    requestHandlers: new Map([
      ["ECHO", async (data: unknown) => ({ at: new Date(0), echoed: data })],
      [
        "DEFERRED",
        async () => {
          throw new HttpDeferredError(retryAt);
        },
      ],
    ]),
    retentionService: strictFake<MainWorkerServices["retentionService"]>({}),
    sourceEnqueuer: new SourceEnqueuer(taskQueue, connection),
    sourcesDataService: strictFake<SourcesDataService>({
      async findSourceById() {
        return source;
      },
      async getSourcesToProcess() {
        return [source];
      },
    }),
    webSubSubscriber: strictFake<MainWorkerServices["webSubSubscriber"]>({}),
  });
  const requests = new WorkerRequests(requestQueue, () => requestEvents, 5_000);

  try {
    await mainWorker.initialize();
    await parsing;

    expect(await requests.request("ECHO", { a: 1 })).toEqual({
      at: "1970-01-01T00:00:00.000Z",
      echoed: { a: 1 },
    });
    await expect(requests.request("DEFERRED", {})).rejects.toEqual(
      new HttpDeferredError(retryAt),
    );
  } finally {
    release();
    await mainWorker.cleanup();
  }
});

test("a request no worker consumes fails as a deadline", async () => {
  const unconsumed = new Queue(`requests-unconsumed-${suffix}`, {
    connection,
  });
  const unconsumedEvents = new QueueEvents(unconsumed.name, {
    connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
  });
  const requests = new WorkerRequests(unconsumed, () => unconsumedEvents, 300);

  try {
    await expect(requests.request("ECHO", {})).rejects.toBeInstanceOf(
      HttpDeadlineError,
    );
    expect(await unconsumed.getWaitingCount()).toBe(1);
  } finally {
    await unconsumed.obliterate({ force: true });
    await unconsumedEvents.close();
    await unconsumed.close();
  }
});

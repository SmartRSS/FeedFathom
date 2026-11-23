import type { AppConfig } from "#platform/config.ts";
import type { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { RetentionService } from "#features/feeds/retention.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { WebSubSubscriber } from "#features/feeds/websub-subscriber.ts";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";
import {
  parseSourceJobId,
  pendingParseRefreshKey,
  SourceEnqueuer,
} from "#features/feeds/source-enqueue.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { MainWorker } from "#features/jobs/main.ts";
import { JobName } from "#features/feeds/queued-job.ts";

const redisUrl = requireDisposableRedisUrl();
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const queueName = `main-worker-test-${crypto.randomUUID()}`;
const queue = new Queue(queueName, { connection });
const enqueuer = new SourceEnqueuer(queue, connection);

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
const jobId = parseSourceJobId(source.id);
const pendingKey = pendingParseRefreshKey(source.id);

const eventually = async (
  check: () => Promise<boolean> | boolean,
  deadline = Date.now() + 2_000,
): Promise<boolean> => {
  if (await check()) return true;
  if (Date.now() > deadline) return false;
  await Bun.sleep(10);
  return await eventually(check, deadline);
};

const config = strictFake<AppConfig>({
  CLEANUP_INTERVAL: 20,
  GATHER_JOBS_INTERVAL: 30,
  LOCK_DURATION: 30,
  WORKER_CONCURRENCY: 2,
});

beforeEach(async () => {
  await queue.obliterate({ force: true });
  await connection.del(pendingKey);
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await connection.del(pendingKey);
  await queue.close();
  await workerConnection.quit();
  await connection.quit();
});

async function startPolledSource() {
  const parsed: [boolean | undefined, string | undefined][] = [];
  const { promise: running, resolve: started } = Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const mainWorker = new MainWorker({
    bullmqQueue: { async upsertJobScheduler() {} },
    config,
    createWorker: (processor, options) =>
      new Worker(queueName, processor, {
        ...options,
        connection: workerConnection,
      }),
    faviconRefresher: strictFake<FaviconRefresher>({}),
    feedParser: strictFake<FeedParser>({
      async parseSource({ skipCache, trigger }) {
        parsed.push([skipCache, trigger]);
        if (parsed.length > 1) return;
        started();
        await released;
      },
    }),
    retentionService: strictFake<RetentionService>({}),
    sourceEnqueuer: enqueuer,
    sourcesDataService: strictFake<SourcesDataService>({
      async findSourceById() {
        return source;
      },
      async getSourcesToProcess() {
        return [source];
      },
    }),
    webSubSubscriber: strictFake<WebSubSubscriber>({}),
  });
  await mainWorker.initialize();
  await running;
  expect(await (await queue.getJob(jobId))?.getState()).toBe("active");

  return {
    async finish() {
      release();
      await eventually(async () => {
        const { jobs, marker } = await outstanding();
        return jobs === 0 && marker === null;
      });
      await mainWorker.cleanup();
      return parsed;
    },
  };
}

const outstanding = async () => ({
  jobs: await queue.getJobCountByTypes(
    "active",
    "delayed",
    "prioritized",
    "waiting",
  ),
  marker: await connection.get(pendingKey),
});

test.each([
  [[false], false],
  [[false, false], false],
  [[false, true], true],
  [[true, false], true],
  [[true, true, false], true],
])(
  "refreshes %p landing on a running parse get one follow-up with skipCache %p",
  async (skipCaches, followUpSkipCache) => {
    const run = await startPolledSource();

    for (const skipCache of skipCaches) {
      // eslint-disable-next-line no-await-in-loop -- Arrival order is the case.
      await enqueuer.enqueueSource(source, "websub-push", skipCache);
    }

    expect(await run.finish()).toEqual([
      [undefined, undefined],
      [followUpSkipCache, "manual"],
    ]);
    expect(await outstanding()).toEqual({ jobs: 0, marker: null });
  },
);

test("concurrent refreshes on a running parse fold into one follow-up that bypasses the cache", async () => {
  const run = await startPolledSource();

  await Promise.all(
    [false, true, false, false].map((skipCache) =>
      enqueuer.enqueueSource(source, "websub-push", skipCache),
    ),
  );

  expect(await run.finish()).toEqual([
    [undefined, undefined],
    [true, "manual"],
  ]);
  expect(await outstanding()).toEqual({ jobs: 0, marker: null });
});

test("scheduled jobs run without leaving finished jobs behind, and cleanup stops the worker", async () => {
  const ran: string[] = [];
  let worker: Worker | undefined;
  const mainWorker = new MainWorker({
    bullmqQueue: queue,
    config,
    createWorker: (processor, options) => {
      worker = new Worker(queueName, processor, {
        ...options,
        connection: workerConnection,
      });
      return worker;
    },
    faviconRefresher: strictFake<FaviconRefresher>({
      async enqueueRefreshes() {
        ran.push(JobName.GatherFaviconJobs);
      },
    }),
    feedParser: strictFake<FeedParser>({}),
    retentionService: strictFake<RetentionService>({
      async prune() {
        ran.push(JobName.Cleanup);
      },
    }),
    sourceEnqueuer: enqueuer,
    sourcesDataService: strictFake<SourcesDataService>({
      async getSourcesDueFaviconRefresh() {
        return [];
      },
      async getSourcesToProcess() {
        ran.push(JobName.GatherJobs);
        return [];
      },
    }),
    webSubSubscriber: strictFake<WebSubSubscriber>({
      async renewDue() {
        ran.push(JobName.WebSubRenewal);
      },
    }),
  });

  await mainWorker.initialize();
  const settled = await eventually(
    async () =>
      ran.length === 5 &&
      (await queue.getJobCountByTypes("active", "waiting")) === 0,
  );

  expect(settled).toBe(true);
  expect(ran.toSorted()).toEqual(
    [
      JobName.Cleanup,
      JobName.GatherFaviconJobs,
      JobName.GatherJobs,
      JobName.GatherJobs,
      JobName.WebSubRenewal,
    ].toSorted(),
  );
  expect(await queue.getJobCountByTypes("completed", "failed")).toBe(0);
  expect(worker?.isRunning()).toBe(true);
  await mainWorker.cleanup();
  expect(worker?.isRunning()).toBe(false);
});

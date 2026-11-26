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
import { WorkerJobs } from "#platform/worker-jobs.ts";
import {
  pendingParseRefreshKey,
  SourceEnqueuer,
} from "#features/feeds/source-enqueue.ts";
import {
  createSourceJobHandlers,
  SourceJobs,
} from "#features/feeds/source-jobs.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { MainWorker } from "#features/jobs/main.ts";

const idleRequestWorker = {
  async close() {},
  on() {},
  async waitUntilReady() {},
};

const redisUrl = requireDisposableRedisUrl();
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const queueName = `source-jobs-test-${crypto.randomUUID()}`;
const queue = new Queue(queueName, { connection });
const sourceJobs = new SourceJobs(new WorkerJobs(queue));

const firstId = 1 + Math.floor(Math.random() * 2_000_000_000);
const source = (id: number) => ({
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  favicon: null,
  homeUrl: "https://example.com",
  id,
  kind: "feed" as const,
  lastAttempt: null,
  lastFetchTrigger: null,
  lastSuccess: null,
  recentFailureDetails: "",
  recentFailures: 0,
  reservedBy: null,
  subscriberCount: 1,
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
  url: `https://example.com/feed/${id}`,
  websubCallbackToken: null,
  websubHubUrl: null,
  websubLeaseExpiresAt: null,
  websubSecret: null,
  websubStatus: "none" as const,
  websubSubscribeAttemptedAt: null,
  websubTopicUrl: null,
});
const ids = [firstId, firstId + 1, firstId + 2];

const eventually = async (
  check: () => Promise<boolean> | boolean,
  deadline = Date.now() + 5_000,
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

const clear = async () => {
  await queue.obliterate({ force: true });
  await connection.del(...ids.map(pendingParseRefreshKey));
};

beforeEach(clear);

afterAll(async () => {
  await clear();
  await queue.close();
  await workerConnection.quit();
  await connection.quit();
});

const outstanding = async () => ({
  jobs: await queue.getJobCountByTypes(
    "active",
    "delayed",
    "prioritized",
    "waiting",
  ),
  markers: (
    await Promise.all(
      ids.map((id) => connection.get(pendingParseRefreshKey(id))),
    )
  ).filter((marker) => marker !== null),
});

async function runWorker(parse: FeedParser["parseSource"]) {
  const mainWorker = new MainWorker({
    bullmqQueue: { async upsertJobScheduler() {} },
    config,
    createRequestWorker: () => idleRequestWorker,
    createWorker: (processor, options) =>
      new Worker(queueName, processor, {
        ...options,
        connection: workerConnection,
      }),
    faviconRefresher: strictFake<FaviconRefresher>({}),
    feedParser: strictFake<FeedParser>({ parseSource: parse }),
    jobHandlers: new Map(
      createSourceJobHandlers({
        httpClient: { async seedCache() {} },
        sourceEnqueuer: new SourceEnqueuer(queue, connection),
      }),
    ),
    requestHandlers: new Map(),
    retentionService: strictFake<RetentionService>({}),
    sourceEnqueuer: new SourceEnqueuer(queue, connection),
    sourcesDataService: strictFake<SourcesDataService>({
      async findSourceById(id) {
        return source(id);
      },
      async getSourcesToProcess() {
        return [];
      },
    }),
    webSubSubscriber: strictFake<WebSubSubscriber>({}),
  });
  await mainWorker.initialize();
  return mainWorker;
}

test.each([
  ["cache-eligible pushes", [false, false, false, false, false], false],
  ["pushes and one refresh", [false, false, true, false, false], true],
  ["refreshes", [true, true, true, true, true], true],
])(
  "%s queued before the worker runs fold onto at most two parses, the last as strong as any request",
  async (_name, bypasses, lastBypass) => {
    const sourceId = firstId;
    const feed = source(sourceId);
    for (const bypass of bypasses) {
      // eslint-disable-next-line no-await-in-loop -- Arrival order is the case.
      if (bypass) await sourceJobs.refresh([sourceId]);
      // eslint-disable-next-line no-await-in-loop -- Arrival order is the case.
      else await sourceJobs.push(feed, Buffer.from("<rss/>"), new Headers());
    }
    expect(await queue.getJobCountByTypes("waiting")).toBe(bypasses.length);

    const parsed: (boolean | undefined)[] = [];
    const { promise: requestsHandled, resolve: handled } =
      Promise.withResolvers<void>();
    const mainWorker = await runWorker(async ({ skipCache }) => {
      parsed.push(skipCache);
      if (parsed.length === 1) await requestsHandled;
    });
    await eventually(async () => {
      const pending = await queue.getJobs(["active", "waiting"]);
      return pending.every((job) => job.name === "parseSource");
    });
    handled();
    const idle = await eventually(async () => {
      const { jobs, markers } = await outstanding();
      return jobs === 0 && markers.length === 0;
    });
    await mainWorker.cleanup();

    expect(idle).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed.length).toBeLessThanOrEqual(2);
    expect(parsed.at(-1) ?? false).toBe(lastBypass);
  },
);

test("an imported batch is one job that queues a parse for every source", async () => {
  await sourceJobs.refresh(ids);
  expect(await queue.getJobCountByTypes("waiting")).toBe(1);

  const parsed: [number, boolean | undefined][] = [];
  const mainWorker = await runWorker(async ({ id, skipCache }) => {
    parsed.push([id, skipCache]);
  });
  const done = await eventually(() => parsed.length === ids.length);
  await mainWorker.cleanup();

  expect(done).toBe(true);
  expect(parsed.toSorted(([left], [right]) => left - right)).toEqual(
    ids.map((id) => [id, true]),
  );
  expect(await outstanding()).toEqual({ jobs: 0, markers: [] });
});

import type { AppConfig } from "#platform/config.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";
import {
  parseSourceJobId,
  pendingParseRefreshKey,
  SourceEnqueuer,
  type SourceParseJobHandle,
  type SourceParseQueue,
  type SourceParseRedis,
} from "#features/feeds/source-enqueue.ts";
import { MainWorker, type MainWorkerServices } from "#features/jobs/main.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";

const idleRequestWorker = {
  async close() {},
  on() {},
  async waitUntilReady() {},
};

const eventually = async (
  check: () => Promise<boolean> | boolean,
  deadline = Date.now() + 2_000,
): Promise<boolean> => {
  if (await check()) return true;
  if (Date.now() > deadline) return false;
  await Bun.sleep(10);
  return await eventually(check, deadline);
};

describe("refresh requests racing the ParseSource worker", () => {
  const connection = new Redis(requireDisposableRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
  const queueName = `refresh-race-test-${crypto.randomUUID()}`;
  const queue = new Queue(queueName, { connection });
  const id = 1 + Math.floor(Math.random() * 2_000_000_000);
  const jobId = parseSourceJobId(id);
  const pendingKey = pendingParseRefreshKey(id);
  const source = {
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
    url: "https://example.com/feed",
    websubCallbackToken: null,
    websubHubUrl: null,
    websubLeaseExpiresAt: null,
    websubSecret: null,
    websubStatus: "none" as const,
    websubSubscribeAttemptedAt: null,
    websubTopicUrl: null,
  };
  const enqueuer = new SourceEnqueuer(queue, connection);
  const started: MainWorker[] = [];

  const redisWith = (hooks: {
    afterExists?: () => void;
    afterTake?: () => Promise<void>;
  }): SourceParseRedis => ({
    eval: async (script, keys, ...args) =>
      await connection.eval(script, keys, ...args),
    async exists(key) {
      const found = await connection.exists(key);
      hooks.afterExists?.();
      return found;
    },
    async getdel(key) {
      const value = await connection.getdel(key);
      await hooks.afterTake?.();
      return value;
    },
    set: async (key, value, mode) =>
      mode
        ? await connection.set(key, value, mode)
        : await connection.set(key, value),
  });

  const queueWithHolder = (
    getState: (holder: SourceParseJobHandle) => Promise<string>,
  ): SourceParseQueue => ({
    add: queue.add.bind(queue),
    addBulk: queue.addBulk.bind(queue),
    async getJob(jobIdToFind) {
      const holder = await queue.getJob(jobIdToFind);
      if (!holder) return holder;
      return { getState: async () => await getState(holder) };
    },
    toKey: queue.toKey,
  });

  const startWorker = async (
    redis: SourceParseRedis,
    row:
      | typeof source
      | (Omit<typeof source, "kind"> & { kind: "email" }) = source,
  ) => {
    const parses: [boolean | undefined, string | undefined][] = [];
    const lookups = { count: 0 };
    const mainWorker = new MainWorker({
      bullmqQueue: { async upsertJobScheduler() {} },
      config: strictFake<AppConfig>(
        {
          CLEANUP_INTERVAL: 20,
          GATHER_JOBS_INTERVAL: 30,
          LOCK_DURATION: 40,
          WORKER_CONCURRENCY: 2,
        },
        "config",
      ),
      createRequestWorker: () => idleRequestWorker,
      createWorker: (processor, options) =>
        new Worker(queueName, processor, { ...options, connection }),
      faviconRefresher: strictFake<MainWorkerServices["faviconRefresher"]>(
        {},
        "faviconRefresher",
      ),
      feedParser: strictFake<FeedParser>(
        {
          async parseSource(input) {
            parses.push([input.skipCache, input.trigger]);
          },
        },
        "feedParser",
      ),
      jobHandlers: new Map(),
      requestHandlers: new Map(),
      retentionService: strictFake<MainWorkerServices["retentionService"]>(
        {},
        "retentionService",
      ),
      sourceEnqueuer: new SourceEnqueuer(queue, redis),
      sourcesDataService: strictFake<SourcesDataService>(
        {
          async findSourceById() {
            lookups.count++;
            return row;
          },
          async getSourcesToProcess() {
            return [];
          },
        },
        "sourcesDataService",
      ),
      webSubSubscriber: strictFake<MainWorkerServices["webSubSubscriber"]>(
        {},
        "webSubSubscriber",
      ),
    });
    started.push(mainWorker);
    await mainWorker.initialize();
    return { lookups, parses };
  };

  const settled = async () =>
    await eventually(
      async () =>
        (await queue.getJob(jobId)) === undefined &&
        (await connection.exists(pendingKey)) === 0,
    );

  afterEach(async () => {
    await Promise.all(started.splice(0).map((worker) => worker.cleanup()));
    await queue.obliterate({ force: true });
    await connection.del(pendingKey);
  });

  afterAll(async () => {
    await queue.close();
    await connection.quit();
  });

  test("a refresh whose add loses to a poll still parses with its bypass", async () => {
    const pollFirst: SourceParseQueue = {
      add: queue.add.bind(queue),
      addBulk: queue.addBulk.bind(queue),
      async getJob(jobIdToFind) {
        const holder = await queue.getJob(jobIdToFind);
        await enqueuer.enqueueDueSources([source]);
        return holder;
      },
      toKey: queue.toKey,
    };

    await new SourceEnqueuer(pollFirst, connection).enqueueSource(source);
    const { parses } = await startWorker(redisWith({}));

    expect(
      await eventually(() => parses.some(([skipCache]) => skipCache === true)),
    ).toBe(true);
    expect(await settled()).toBe(true);
  });

  test("a refresh that finds its queued job already taken is parsed after that run", async () => {
    await enqueuer.enqueueDueSources([source]);
    const taken = Promise.withResolvers<void>();
    const merged = Promise.withResolvers<void>();
    let paused = false;
    const worker = redisWith({
      async afterTake() {
        if (paused) return;
        paused = true;
        taken.resolve();
        await merged.promise;
      },
    });
    let parses: [boolean | undefined, string | undefined][] = [];
    const racing = queueWithHolder(async (holder) => {
      const state = await holder.getState();
      ({ parses } = await startWorker(worker));
      await taken.promise;
      return state;
    });

    await new SourceEnqueuer(racing, connection).enqueueSource(source);
    merged.resolve();

    expect(
      await eventually(() => parses.some(([skipCache]) => skipCache === true)),
    ).toBe(true);
    expect(await settled()).toBe(true);
  });

  test("a refresh landing after the run's last marker take is parsed after that run", async () => {
    await enqueuer.enqueueDueSources([source]);
    let refreshed = false;
    const { parses } = await startWorker(
      redisWith({
        async afterTake() {
          if (refreshed) return;
          refreshed = true;
          await enqueuer.enqueueSource(source);
        },
      }),
    );

    expect(
      await eventually(() => parses.some(([skipCache]) => skipCache === true)),
    ).toBe(true);
    expect(await settled()).toBe(true);
  });

  test("a refresh that saw its job active and marks after that job finished still gets a parse", async () => {
    await enqueuer.enqueueDueSources([source]);
    const checked = Promise.withResolvers<void>();
    const holding = Promise.withResolvers<void>();
    const sawActive = Promise.withResolvers<void>();
    let held = false;
    const { parses } = await startWorker(
      redisWith({
        afterExists: () => checked.resolve(),
        async afterTake() {
          if (held) return;
          held = true;
          holding.resolve();
          await sawActive.promise;
        },
      }),
    );
    await holding.promise;
    const late = queueWithHolder(async (holder) => {
      const state = await holder.getState();
      sawActive.resolve();
      await eventually(async () => (await queue.getJob(jobId)) === undefined);
      await Promise.race([checked.promise, Bun.sleep(500)]);
      return state;
    });

    await new SourceEnqueuer(late, connection).enqueueSource(source);

    expect(
      await eventually(() => parses.some(([skipCache]) => skipCache === true)),
    ).toBe(true);
    expect(await settled()).toBe(true);
  });

  test("a refresh of an email source settles without a parse or a second run", async () => {
    await enqueuer.enqueueSource(source);
    const { lookups, parses } = await startWorker(redisWith({}), {
      ...source,
      kind: "email",
      url: "abc@mail.example",
    });

    expect(await settled()).toBe(true);
    await Bun.sleep(100);
    expect(lookups.count).toBe(1);
    expect(parses).toEqual([]);
  });
});

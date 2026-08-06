import { expect, test } from "bun:test";
import { DelayedError } from "bullmq";
import {
  MainWorker,
  type MainWorkerFactory,
  type MainWorkerJob,
  type MainWorkerQueue,
} from "../src/lib/workers/main.ts";
import { HttpDeferredError } from "../src/lib/http-client.ts";
import { JobName } from "../src/types/job-name-enum.ts";

const source = {
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  favicon: null,
  homeUrl: "https://example.com",
  id: 1,
  lastAttempt: null,
  lastSuccess: null,
  recentFailureDetails: "",
  recentFailures: 0,
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
  url: "https://example.com/feed",
};

const config = {
  CLEANUP_INTERVAL: 20,
  GATHER_JOBS_INTERVAL: 30,
  LOCK_DURATION: 40,
  WORKER_CONCURRENCY: 2,
};

const idleSources = {
  async findSourceById() {
    return source;
  },
  async getRecentlySuccessfulSources() {
    return [];
  },
  async getSourcesToProcess() {
    return [];
  },
};

const idleParser = {
  async parseSource() {},
  async refreshFavicon() {},
};

const idleCleanupOrphanedData = async () => {};

const idleJobFailures = {
  async record() {},
};

const noopWorkerFactory: MainWorkerFactory = () => ({
  async close() {},
  onFailed() {},
});

const parseJob = (data: unknown): MainWorkerJob => ({
  data,
  async moveToDelayed() {},
  name: JobName.ParseSource,
});

test("initialize schedules configured intervals and starts the worker", async () => {
  const repeatIntervals = new Map<string, number>();
  let workerOptions: Parameters<MainWorkerFactory>[1] | undefined;
  const queue: MainWorkerQueue = {
    async add(name, _data, options) {
      if (options?.repeat) repeatIntervals.set(name, options.repeat.every);
    },
    async addBulk() {},
  };
  const createWorker: MainWorkerFactory = (_processor, options) => {
    workerOptions = options;
    return noopWorkerFactory(_processor, options);
  };
  const worker = new MainWorker(
    config,
    queue,
    idleParser,
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
  );

  await worker.initialize();

  expect(repeatIntervals.get(JobName.Cleanup)).toBe(20_000);
  expect(repeatIntervals.get(JobName.GatherJobs)).toBe(30_000);
  expect(workerOptions).toEqual({ concurrency: 2, lockDuration: 40_000 });
});

test("captured processor parses the queued source", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  let parsedSource: unknown;
  const queue: MainWorkerQueue = {
    async add() {},
    async addBulk() {},
  };
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = new MainWorker(
    config,
    queue,
    {
      async parseSource(value) {
        parsedSource = value;
      },
      async refreshFavicon() {},
    },
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
  );

  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");
  await processor({
    ...parseJob({ id: source.id, skipCache: true, url: source.url }),
  });

  expect(parsedSource).toEqual({ ...source, skipCache: true });
});

test("moves deferred validated jobs with their BullMQ token", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const delays: [number, string | undefined][] = [];
  const retryAt = Date.now() + 60_000;
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = new MainWorker(
    config,
    { async add() {}, async addBulk() {} },
    {
      async parseSource() {
        throw new HttpDeferredError(retryAt);
      },
      async refreshFavicon() {},
    },
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  const processing = processor({
    data: { id: source.id, url: source.url },
    async moveToDelayed(timestamp, token) {
      delays.push([timestamp, token]);
    },
    name: JobName.ParseSource,
    token: "worker-token",
  });

  await expect(processing).rejects.toBeInstanceOf(DelayedError);
  expect(delays).toEqual([[retryAt, "worker-token"]]);
});

test("refreshes favicons only for validated job data", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const refreshed: { homeUrl: string; id: number }[] = [];
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = new MainWorker(
    config,
    { async add() {}, async addBulk() {} },
    {
      async parseSource() {},
      async refreshFavicon(value) {
        refreshed.push(value);
      },
    },
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  await processor({
    data: { homeUrl: source.homeUrl, id: source.id },
    async moveToDelayed() {},
    name: JobName.RefreshFavicon,
  });

  expect(refreshed).toEqual([{ homeUrl: source.homeUrl, id: source.id }]);
});

test("starts every favicon queue addition before awaiting completion", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  let blockFaviconAdds = false;
  const started: string[] = [];
  const allStarted = Promise.withResolvers<void>();
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const priorities: (number | undefined)[] = [];
  const queue: MainWorkerQueue = {
    async add(_name, _data, options) {
      if (!blockFaviconAdds) return;
      started.push(options?.jobId ?? "");
      priorities.push(options?.priority);
      if (started.length === gates.length) allStarted.resolve();
      await gates[started.length - 1]?.promise;
    },
    async addBulk() {},
  };
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = new MainWorker(
    config,
    queue,
    idleParser,
    {
      ...idleSources,
      async getRecentlySuccessfulSources() {
        return [source, { ...source, id: 2 }];
      },
    },
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");
  const processJob = processor;
  blockFaviconAdds = true;

  const processing = processJob({
    data: {},
    async moveToDelayed() {},
    name: JobName.GatherFaviconJobs,
  });
  await allStarted.promise;
  expect(started).toEqual([
    `${JobName.RefreshFavicon}-1`,
    `${JobName.RefreshFavicon}-2`,
  ]);
  // RefreshFavicon jobs must carry an explicit (nonzero) priority so
  // BullMQ never lets a favicon-refresh backlog crowd out ParseSource,
  // which is added with no priority.
  expect(priorities).toEqual([10, 10]);

  let finished = false;
  void processing.then(() => {
    finished = true;
  });
  gates[0]?.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);

  gates[1]?.resolve();
  await processing;
  expect(finished).toBe(true);
});

test("rejects malformed and unknown jobs before downstream calls", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const downstreamCalls: string[] = [];
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = new MainWorker(
    config,
    {
      async add() {
        downstreamCalls.push("queue.add");
      },
      async addBulk() {
        downstreamCalls.push("queue.addBulk");
      },
    },
    {
      async parseSource() {
        downstreamCalls.push("parseSource");
      },
      async refreshFavicon() {
        downstreamCalls.push("refreshFavicon");
      },
    },
    {
      async findSourceById() {
        downstreamCalls.push("findSourceById");
        return source;
      },
      async getRecentlySuccessfulSources() {
        downstreamCalls.push("getRecentlySuccessfulSources");
        return [];
      },
      async getSourcesToProcess() {
        downstreamCalls.push("getSourcesToProcess");
        return [];
      },
    },
    async () => {
      downstreamCalls.push("cleanup");
    },
    idleJobFailures,
    createWorker,
  );
  await worker.initialize();
  downstreamCalls.length = 0;
  if (!processor) throw new Error("Worker processor was not captured");
  const processJob = processor;
  const malformedJobs: { data: unknown; name: string }[] = [
    { data: { unexpected: true }, name: JobName.Cleanup },
    { data: null, name: JobName.GatherFaviconJobs },
    { data: [], name: JobName.GatherJobs },
    {
      data: { id: source.id, url: "not a web URL" },
      name: JobName.ParseSource,
    },
    {
      data: { homeUrl: source.homeUrl, id: 1.5 },
      name: JobName.RefreshFavicon,
    },
    { data: {}, name: "unknown" },
  ];

  await Promise.all(
    malformedJobs.map(async (malformed) => {
      await processJob({
        ...malformed,
        async moveToDelayed() {},
      });
    }),
  );

  expect(downstreamCalls).toEqual([]);
});

test("cleanup delegates to the worker", async () => {
  let closeCalls = 0;
  const queue: MainWorkerQueue = {
    async add() {},
    async addBulk() {},
  };
  const createWorker: MainWorkerFactory = () => ({
    async close() {
      closeCalls++;
    },
    onFailed() {},
  });
  const worker = new MainWorker(
    config,
    queue,
    idleParser,
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
  );
  await worker.initialize();

  await worker.cleanup();

  expect(closeCalls).toBe(1);
});

test("records a durable failure for non-ParseSource job errors", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const recorded: [string, string][] = [];
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = new MainWorker(
    config,
    { async add() {}, async addBulk() {} },
    idleParser,
    idleSources,
    async () => {
      throw new Error("cleanup exploded");
    },
    {
      async record(jobType, errorMessage) {
        recorded.push([jobType, errorMessage]);
      },
    },
    createWorker,
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  await processor({
    data: {},
    async moveToDelayed() {},
    name: JobName.Cleanup,
  });

  expect(recorded).toEqual([[JobName.Cleanup, "cleanup exploded"]]);
});

test("a failure while recording a job failure doesn't itself fail the job", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = new MainWorker(
    config,
    { async add() {}, async addBulk() {} },
    idleParser,
    idleSources,
    async () => {
      throw new Error("cleanup exploded");
    },
    {
      async record() {
        throw new Error("database unavailable");
      },
    },
    createWorker,
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  // Must resolve, not reject -- BullMQ should always see the job as
  // acknowledged, even if persisting the failure record itself fails.
  await expect(
    processor({ data: {}, async moveToDelayed() {}, name: JobName.Cleanup }),
  ).resolves.toBeUndefined();
});

test("a poisoned error whose message getter throws doesn't fail the job either", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  class PoisonedError extends Error {
    override get message(): string {
      throw new Error("message getter exploded");
    }
  }
  const worker = new MainWorker(
    config,
    { async add() {}, async addBulk() {} },
    idleParser,
    idleSources,
    async () => {
      throw new PoisonedError();
    },
    idleJobFailures,
    createWorker,
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  await expect(
    processor({ data: {}, async moveToDelayed() {}, name: JobName.Cleanup }),
  ).resolves.toBeUndefined();
});

test("an HttpDeferredError with a poisoned retryAt getter doesn't fail the job", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const recorded: [string, string][] = [];
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  // Deliberately malformed: a real HttpDeferredError with a throwing getter,
  // to prove the code under test survives a poisoned retryAt read. There's
  // no type-safe way to construct that.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const evilDeferredError = Object.create(HttpDeferredError.prototype, {
    retryAt: {
      get() {
        throw new Error("poisoned retryAt getter");
      },
    },
  }) as HttpDeferredError;
  const worker = new MainWorker(
    config,
    { async add() {}, async addBulk() {} },
    {
      async parseSource() {
        throw evilDeferredError;
      },
      async refreshFavicon() {},
    },
    idleSources,
    idleCleanupOrphanedData,
    {
      async record(jobType, errorMessage) {
        recorded.push([jobType, errorMessage]);
      },
    },
    createWorker,
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  await expect(
    processor({
      data: { id: source.id, url: source.url },
      async moveToDelayed() {
        throw new Error("should never be called with a poisoned retryAt");
      },
      name: JobName.ParseSource,
      token: "worker-token",
    }),
  ).resolves.toBeUndefined();
  expect(recorded).toEqual([[JobName.ParseSource, ""]]);
});

test("a moveToDelayed rejection (e.g. a real BullMQ/Redis failure) doesn't fail the job", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const recorded: [string, string][] = [];
  const retryAt = Date.now() + 60_000;
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = new MainWorker(
    config,
    { async add() {}, async addBulk() {} },
    {
      async parseSource() {
        throw new HttpDeferredError(retryAt);
      },
      async refreshFavicon() {},
    },
    idleSources,
    idleCleanupOrphanedData,
    {
      async record(jobType, errorMessage) {
        recorded.push([jobType, errorMessage]);
      },
    },
    createWorker,
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  await expect(
    processor({
      data: { id: source.id, url: source.url },
      async moveToDelayed() {
        throw new Error("Redis connection lost");
      },
      name: JobName.ParseSource,
      token: "worker-token",
    }),
  ).resolves.toBeUndefined();
  expect(recorded[0]?.[0]).toBe(JobName.ParseSource);
  expect(recorded[0]?.[1]).toStartWith("Request deferred until ");
});

test("a moveToDelayed rejection with a poisoned prototype doesn't fail the job", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const recorded: [string, string][] = [];
  const retryAt = Date.now() + 60_000;
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = new MainWorker(
    config,
    { async add() {}, async addBulk() {} },
    {
      async parseSource() {
        throw new HttpDeferredError(retryAt);
      },
      async refreshFavicon() {},
    },
    idleSources,
    idleCleanupOrphanedData,
    {
      async record(jobType, errorMessage) {
        recorded.push([jobType, errorMessage]);
      },
    },
    createWorker,
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  const poisonedMoveError = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("poisoned getPrototypeOf trap");
      },
    },
  );

  await expect(
    processor({
      data: { id: source.id, url: source.url },
      async moveToDelayed() {
        throw poisonedMoveError;
      },
      name: JobName.ParseSource,
      token: "worker-token",
    }),
  ).resolves.toBeUndefined();
  expect(recorded[0]?.[0]).toBe(JobName.ParseSource);
});

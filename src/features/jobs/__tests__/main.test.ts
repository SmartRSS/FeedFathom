import type { AppConfig } from "#platform/config.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import type { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import type { HubPoster } from "#features/feeds/websub.ts";
import type { JobFailuresDataService } from "#features/admin/job-failure-data-service.ts";
import { expect, mock, test } from "bun:test";
import { DelayedError, type Queue } from "bullmq";
import { JobName } from "#shared/types/job-name-enum.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import type { MainWorkerJob } from "#features/jobs/main.ts";

type QueueOptions = {
  jobId?: string;
  priority?: number;
  removeOnComplete?: { count: number };
  removeOnFail?: { count: number };
};

type QueueJob = {
  data: unknown;
  name: string;
  opts?: QueueOptions;
};

type MainWorkerQueue = {
  upsertJobScheduler?(
    ...args: Parameters<Queue["upsertJobScheduler"]>
  ): Promise<unknown>;
  add(name: string, data: unknown, options?: QueueOptions): Promise<unknown>;
  addBulk(jobs: QueueJob[]): Promise<unknown>;
};

type WorkerControls = {
  close(): Promise<unknown>;
  onFailed(
    listener: (job: { id?: string } | undefined, error: unknown) => void,
  ): void;
};

type MainWorkerFactory = (
  processor: (job: MainWorkerJob) => Promise<void>,
  options: { concurrency: number; lockDuration: number },
) => WorkerControls;

const source = {
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  favicon: null,
  homeUrl: "https://example.com",
  id: 1,
  kind: "feed" as const,
  lastAttempt: null,
  lastFetchTrigger: null,
  lastSuccess: null,
  recentFailureDetails: "",
  recentFailures: 0,
  subscriberCount: 3,
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
  async getWebSubSubscriptionsNeedingRenewal() {
    return [];
  },
  async markWebSubFailed() {},
};

const idleParser = {
  async parseSource() {},
};

const idleFaviconRefresher = {
  async refreshFavicon() {},
};

const idleCleanupOrphanedData = async () => [];

const idleUserSources = {
  async recomputeUnreadCounts() {},
};

const idleSourceEnqueuer = {
  async enqueueSource() {},
  async takePendingRefresh() {
    return null;
  },
};

const idleHubPoster = {
  async post() {
    return { status: 202 };
  },
};

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

type MainWorkerConfig = Pick<
  AppConfig,
  | "CLEANUP_INTERVAL"
  | "FEED_FATHOM_DOMAIN"
  | "GATHER_JOBS_INTERVAL"
  | "LOCK_DURATION"
  | "WORKER_CONCURRENCY"
>;

type MainWorkerSources = Pick<
  SourcesDataService,
  "findSourceById" | "getRecentlySuccessfulSources" | "getSourcesToProcess"
>;

type MainWorkerWebSubState = Pick<
  WebSubStateService,
  "getWebSubSubscriptionsNeedingRenewal" | "markWebSubFailed"
>;

type MainWorkerUserSources = Pick<
  UserSourcesDataService,
  "recomputeUnreadCounts"
>;

const actualBullmq = { ...(await import("bullmq")) };
async function mockWorkerServices(
  appConfig: MainWorkerConfig,
  bullmqQueue: MainWorkerQueue,
  feedParser: Pick<FeedParser, "parseSource">,
  faviconRefresher: Pick<FaviconRefresher, "refreshFavicon">,
  sourcesDataService: MainWorkerSources,
  websubStateService: MainWorkerWebSubState,
  userSourcesDataService: MainWorkerUserSources,
  cleanupOrphanedData: () => Promise<number[]>,
  jobFailuresDataService: Pick<JobFailuresDataService, "record">,
  createWorker: MainWorkerFactory,
  hubPoster: HubPoster,
  sourceEnqueuer: Pick<
    SourceEnqueuer,
    "enqueueSource" | "takePendingRefresh"
  > = idleSourceEnqueuer,
) {
  await mock.module("#platform/config.ts", () => ({ config: appConfig }));
  await mock.module("#platform/runtime.ts", () => ({
    bullmqQueue: { async upsertJobScheduler() {}, ...bullmqQueue },
    bullmqRedis: {},
    drizzleConnection: {},
    httpClient: hubPoster,
  }));
  await mock.module("#features/feeds/services.ts", () => ({
    feedParser,
    sourcesDataService,
    sourceEnqueuer,
    userSourcesDataService,
    websubStateService,
  }));
  await mock.module("#features/jobs/services.ts", () => ({
    faviconRefresher,
    jobFailuresDataService,
  }));
  await mock.module("#features/feeds/retention.ts", () => ({
    cleanupOrphanedData,
  }));
  await mock.module("bullmq", () => ({
    ...actualBullmq,
    Worker: class {
      private readonly controls: WorkerControls;
      constructor(
        _name: string,
        processor: Parameters<MainWorkerFactory>[0],
        options: Parameters<MainWorkerFactory>[1],
      ) {
        this.controls = createWorker(processor, {
          concurrency: options.concurrency,
          lockDuration: options.lockDuration,
        });
      }
      close() {
        return this.controls.close();
      }
      on(_event: string, listener: Parameters<WorkerControls["onFailed"]>[0]) {
        this.controls.onFailed(listener);
      }
    },
  }));
}
await mockWorkerServices(
  config,
  { async add() {}, async addBulk() {} },
  idleParser,
  idleFaviconRefresher,
  idleSources,
  idleSources,
  idleUserSources,
  idleCleanupOrphanedData,
  idleJobFailures,
  noopWorkerFactory,
  idleHubPoster,
);
const { MainWorker } = await import("#features/jobs/main.ts");
async function createMainWorker(
  appConfig: MainWorkerConfig,
  bullmqQueue: MainWorkerQueue,
  feedParser: Pick<FeedParser, "parseSource">,
  faviconRefresher: Pick<FaviconRefresher, "refreshFavicon">,
  sourcesDataService: MainWorkerSources,
  websubStateService: MainWorkerWebSubState,
  cleanupOrphanedData: () => Promise<number[]>,
  jobFailuresDataService: Pick<JobFailuresDataService, "record">,
  createWorker: MainWorkerFactory,
  hubPoster: HubPoster,
  sourceEnqueuer: Pick<
    SourceEnqueuer,
    "enqueueSource" | "takePendingRefresh"
  > = idleSourceEnqueuer,
  userSourcesDataService: MainWorkerUserSources = idleUserSources,
) {
  await mockWorkerServices(
    appConfig,
    bullmqQueue,
    feedParser,
    faviconRefresher,
    sourcesDataService,
    websubStateService,
    userSourcesDataService,
    cleanupOrphanedData,
    jobFailuresDataService,
    createWorker,
    hubPoster,
    sourceEnqueuer,
  );
  return new MainWorker();
}

test("initialize schedules configured intervals and starts the worker", async () => {
  const repeatIntervals = new Map<string, number>();
  let workerOptions: Parameters<MainWorkerFactory>[1] | undefined;
  const queue: MainWorkerQueue = {
    async add() {},
    async addBulk() {},
    async upsertJobScheduler(name, options) {
      repeatIntervals.set(name, options.every!);
    },
  };
  const createWorker: MainWorkerFactory = (_processor, options) => {
    workerOptions = options;
    return noopWorkerFactory(_processor, options);
  };
  const worker = await createMainWorker(
    config,
    queue,
    idleParser,
    idleFaviconRefresher,
    idleSources,
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
    idleHubPoster,
  );

  await worker.initialize();

  expect(repeatIntervals.get(JobName.Cleanup)).toBe(20_000);
  expect(repeatIntervals.get(JobName.GatherJobs)).toBe(30_000);
  expect(repeatIntervals.get(JobName.GatherFaviconJobs)).toBe(86_400_000);
  expect(repeatIntervals.get(JobName.WebSubRenewal)).toBe(86_400_000);
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
  const worker = await createMainWorker(
    config,
    queue,
    {
      async parseSource(value) {
        parsedSource = value;
      },
    },
    idleFaviconRefresher,
    idleSources,
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
    idleHubPoster,
  );

  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");
  await processor({
    ...parseJob({ id: source.id, skipCache: true, url: source.url }),
  });

  expect(parsedSource).toEqual({
    ...source,
    skipCache: true,
    trigger: "poll",
  });
});

test("moves deferred validated jobs with their BullMQ token", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const delays: [number, string | undefined][] = [];
  const retryAt = Date.now() + 60_000;
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    {
      async parseSource() {
        throw new HttpDeferredError(retryAt);
      },
    },
    idleFaviconRefresher,
    idleSources,
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
    idleHubPoster,
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

// A request that arrived while the job held the source's id was recorded
// rather than queued (the add would have been deduped away); the end of the
// run is where it is collected and answered with one follow-up refresh.
test("folds requests that arrived mid-run into one follow-up refresh", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const followedUp: Parameters<
    SourceEnqueuer["enqueueSource"]
  >[] = [];
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    idleParser,
    idleFaviconRefresher,
    idleSources,
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
    idleHubPoster,
    {
      async enqueueSource(source, trigger, skipCache) {
        followedUp.push([source, trigger, skipCache]);
      },
      async takePendingRefresh(sourceId) {
        return sourceId === source.id ? { skipCache: true } : null;
      },
    },
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  await processor({
    data: { id: source.id, url: source.url },
    async moveToDelayed() {},
    name: JobName.ParseSource,
  });

  expect(followedUp).toEqual([
    [{ id: source.id, url: source.url }, "manual", true],
  ]);
});

// A deferral keeps the job (and its id) alive for another run, so the
// recorded requests stay on the marker for that run to act on -- consuming
// them here would answer the add the retry itself will make.
test("a deferred parse leaves pending refreshes to its retry", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  let taken = 0;
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    {
      async parseSource() {
        throw new HttpDeferredError(Date.now() + 60_000);
      },
    },
    idleFaviconRefresher,
    idleSources,
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
    idleHubPoster,
    {
      async enqueueSource() {},
      async takePendingRefresh() {
        taken += 1;
        return null;
      },
    },
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  const processing = processor({
    data: { id: source.id, url: source.url },
    async moveToDelayed() {},
    name: JobName.ParseSource,
  });
  await expect(processing).rejects.toBeInstanceOf(DelayedError);
  expect(taken).toBe(0);
});

test("refreshes favicons only for validated job data", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const refreshed: { homeUrl: string; id: number }[] = [];
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    idleParser,
    {
      async refreshFavicon(value: { homeUrl: string; id: number }) {
        refreshed.push(value);
      },
    },
    idleSources,
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
    idleHubPoster,
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
  const sourcesWithFaviconTargets = {
    ...idleSources,
    async getRecentlySuccessfulSources() {
      return [source, { ...source, id: 2 }];
    },
  };
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = await createMainWorker(
    config,
    queue,
    idleParser,
    idleFaviconRefresher,
    sourcesWithFaviconTargets,
    sourcesWithFaviconTargets,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
    idleHubPoster,
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
  const worker = await createMainWorker(
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
    },
    {
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
    {
      async getWebSubSubscriptionsNeedingRenewal() {
        downstreamCalls.push("getWebSubSubscriptionsNeedingRenewal");
        return [];
      },
      async markWebSubFailed() {
        downstreamCalls.push("markWebSubFailed");
      },
    },
    async () => {
      downstreamCalls.push("cleanup");
      return [];
    },
    idleJobFailures,
    createWorker,
    idleHubPoster,
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
  const worker = await createMainWorker(
    config,
    queue,
    idleParser,
    idleFaviconRefresher,
    idleSources,
    idleSources,
    idleCleanupOrphanedData,
    idleJobFailures,
    createWorker,
    idleHubPoster,
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
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    idleParser,
    idleFaviconRefresher,
    idleSources,
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
    idleHubPoster,
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

// The prune bypasses the services that own the unread badge, so the worker
// has to hand every source cleanup reports to the recompute itself (#812).
test("cleanup recounts the unread totals of every pruned source", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const recounted: number[][] = [];
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    idleParser,
    idleFaviconRefresher,
    idleSources,
    idleSources,
    async () => [7, 9],
    idleJobFailures,
    createWorker,
    idleHubPoster,
    idleSourceEnqueuer,
    {
      async recomputeUnreadCounts(sourceIds) {
        recounted.push(sourceIds);
      },
    },
  );
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");

  await processor({
    data: {},
    async moveToDelayed() {},
    name: JobName.Cleanup,
  });

  expect(recounted).toEqual([[7, 9]]);
});

test("a failure while recording a job failure doesn't itself fail the job", async () => {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const createWorker: MainWorkerFactory = (value, options) => {
    processor = value;
    return noopWorkerFactory(value, options);
  };
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    idleParser,
    idleFaviconRefresher,
    idleSources,
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
    idleHubPoster,
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
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    idleParser,
    idleFaviconRefresher,
    idleSources,
    idleSources,
    async () => {
      throw new PoisonedError();
    },
    idleJobFailures,
    createWorker,
    idleHubPoster,
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
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    {
      async parseSource() {
        throw evilDeferredError;
      },
    },
    idleFaviconRefresher,
    idleSources,
    idleSources,
    idleCleanupOrphanedData,
    {
      async record(jobType, errorMessage) {
        recorded.push([jobType, errorMessage]);
      },
    },
    createWorker,
    idleHubPoster,
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
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    {
      async parseSource() {
        throw new HttpDeferredError(retryAt);
      },
    },
    idleFaviconRefresher,
    idleSources,
    idleSources,
    idleCleanupOrphanedData,
    {
      async record(jobType, errorMessage) {
        recorded.push([jobType, errorMessage]);
      },
    },
    createWorker,
    idleHubPoster,
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
  const worker = await createMainWorker(
    config,
    { async add() {}, async addBulk() {} },
    {
      async parseSource() {
        throw new HttpDeferredError(retryAt);
      },
    },
    idleFaviconRefresher,
    idleSources,
    idleSources,
    idleCleanupOrphanedData,
    {
      async record(jobType, errorMessage) {
        recorded.push([jobType, errorMessage]);
      },
    },
    createWorker,
    idleHubPoster,
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

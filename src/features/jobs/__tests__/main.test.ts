import type { AppConfig } from "#platform/config.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import type { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import type { JobFailuresDataService } from "#features/admin/job-failure-data-service.ts";
import { expect, test } from "bun:test";
import { DelayedError } from "bullmq";
import { JobName } from "#shared/types/job-name-enum.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import {
  MainWorker,
  type MainWorkerJob,
  type MainWorkerServices,
} from "#features/jobs/main.ts";

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

const config = strictFake<AppConfig>(
  {
    ARTICLE_STALE_AFTER_DAYS: 365,
    CLEANUP_INTERVAL: 20,
    GATHER_JOBS_INTERVAL: 30,
    LOCK_DURATION: 40,
    USER_DORMANT_AFTER_DAYS: 365,
    USER_EXPIRY_DAYS: 730,
    WORKER_CONCURRENCY: 2,
  },
  "config",
);

const idleJobWorker: ReturnType<MainWorkerServices["createWorker"]> = {
  async close() {},
  on() {},
  async waitUntilReady() {},
};

const idleSources = () =>
  strictFake<SourcesDataService>(
    {
      async findSourceById() {
        return source;
      },
      async getSourcesDueFaviconRefresh() {
        return [];
      },
      async getSourcesToProcess() {
        return [];
      },
    },
    "sourcesDataService",
  );

const idleSourceEnqueuer = () =>
  strictFake<SourceEnqueuer>(
    {
      async takePendingRefresh() {
        return null;
      },
    },
    "sourceEnqueuer",
  );

const idleJobFailures = () =>
  strictFake<JobFailuresDataService>(
    { async record() {} },
    "jobFailuresDataService",
  );

// Initializes a MainWorker over idle services, with the test's replacements
// on top, and hands back the job processor it gave its BullMQ worker.
async function startWorker(overrides: Partial<MainWorkerServices> = {}) {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  const worker = new MainWorker({
    bullmqQueue: {
      async add() {},
      async addBulk() {},
      async upsertJobScheduler() {},
    },
    cleanupOrphanedData: async () => [],
    config,
    faviconRefresher: strictFake<FaviconRefresher>({}, "faviconRefresher"),
    feedParser: strictFake<FeedParser>(
      { async parseSource() {} },
      "feedParser",
    ),
    hubPoster: strictFake({}, "hubPoster"),
    jobFailuresDataService: idleJobFailures(),
    sourceEnqueuer: idleSourceEnqueuer(),
    sourcesDataService: idleSources(),
    userSourcesDataService: strictFake<UserSourcesDataService>(
      { async recomputeUnreadCounts() {} },
      "userSourcesDataService",
    ),
    websubStateService: strictFake<WebSubStateService>(
      {},
      "websubStateService",
    ),
    ...overrides,
    createWorker(value, options) {
      processor = value;
      return (overrides.createWorker ?? (() => idleJobWorker))(value, options);
    },
  });
  await worker.initialize();
  if (!processor) throw new Error("Worker processor was not captured");
  return { process: processor, worker };
}

const job = (
  name: string,
  data: unknown,
  overrides: Partial<MainWorkerJob> = {},
): MainWorkerJob => ({
  data,
  async moveToDelayed() {},
  name,
  async updateData() {},
  ...overrides,
});

const parseJob = (overrides: Partial<MainWorkerJob> = {}) =>
  job(JobName.ParseSource, { id: source.id, url: source.url }, overrides);

const deferredParser = (retryAt = Date.now() + 60_000) =>
  strictFake<FeedParser>({
    async parseSource() {
      throw new HttpDeferredError(retryAt);
    },
  });

test("initializes scheduled jobs and closes the worker on cleanup", async () => {
  let closeCalls = 0;
  const repeatIntervals = new Map<string, number>();
  const templates: unknown[] = [];
  let workerOptions: unknown;
  const { worker } = await startWorker({
    bullmqQueue: {
      async add() {},
      async addBulk() {},
      async upsertJobScheduler(name, options, template) {
        repeatIntervals.set(name, options.every);
        templates.push(template.opts);
      },
    },
    createWorker(_processor, options) {
      workerOptions = options;
      return {
        ...idleJobWorker,
        async close() {
          closeCalls++;
        },
      };
    },
  });

  expect(Object.fromEntries(repeatIntervals)).toEqual({
    [JobName.Cleanup]: 20_000,
    [JobName.GatherFaviconJobs]: 86_400_000,
    [JobName.GatherJobs]: 30_000,
    [JobName.WebSubRenewal]: 86_400_000,
  });
  for (const opts of templates) {
    expect(opts).toEqual({
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 0 },
    });
  }
  expect(workerOptions).toEqual({ concurrency: 2, lockDuration: 40_000 });
  expect(closeCalls).toBe(0);
  await worker.cleanup();
  expect(closeCalls).toBe(1);
});

test("captured processor parses the queued source", async () => {
  let parsedSource: unknown;
  const { process } = await startWorker({
    feedParser: strictFake<FeedParser>({
      async parseSource(value) {
        parsedSource = value;
      },
    }),
  });

  await process(
    job(JobName.ParseSource, {
      id: source.id,
      skipCache: true,
      url: source.url,
    }),
  );

  expect(parsedSource).toEqual({
    ...source,
    skipCache: true,
    trigger: "poll",
  });
});

test("moves deferred validated jobs with their BullMQ token", async () => {
  const delays: [number, string | undefined][] = [];
  const retryAt = Date.now() + 60_000;
  const { process } = await startWorker({
    feedParser: deferredParser(retryAt),
  });

  const processing = process(
    parseJob({
      async moveToDelayed(timestamp, token) {
        delays.push([timestamp, token]);
      },
      token: "worker-token",
    }),
  );

  await expect(processing).rejects.toBeInstanceOf(DelayedError);
  expect(delays).toEqual([[retryAt, "worker-token"]]);
});

// A request that arrived while the job held the source's id was recorded
// rather than queued (the add would have been deduped away); the run folds it
// in itself at the end. It cannot hand it back to the enqueuer -- the id is
// still active until this processor returns, so that add would be deduped
// against this very job and the refresh would wait for the next poll.
test("folds requests that arrived mid-run into one more parse", async () => {
  const parsed: Array<[boolean | undefined, string | undefined]> = [];
  const followedUp: Parameters<SourceEnqueuer["enqueueSource"]>[] = [];
  let pending: { skipCache: boolean } | null = { skipCache: true };
  const { process } = await startWorker({
    feedParser: strictFake<FeedParser>({
      async parseSource(input) {
        parsed.push([input.skipCache, input.trigger]);
      },
    }),
    sourceEnqueuer: strictFake<SourceEnqueuer>({
      async enqueueSource(...args) {
        followedUp.push(args);
      },
      // getdel: the take is the consume, so a second call sees nothing.
      async takePendingRefresh(sourceId) {
        if (sourceId !== source.id) return null;
        const taken = pending;
        pending = null;
        return taken;
      },
    }),
  });

  await process(parseJob());

  expect(parsed).toEqual([
    [undefined, "poll"],
    [true, "manual"],
  ]);
  expect(followedUp).toEqual([]);
});

// A deferral keeps the job (and its id) alive for another run, so the
// recorded requests stay on the marker for that run to act on -- consuming
// them here would answer the add the retry itself will make.
test("a deferred parse leaves pending refreshes to its retry", async () => {
  let taken = 0;
  const { process } = await startWorker({
    feedParser: deferredParser(),
    sourceEnqueuer: strictFake<SourceEnqueuer>({
      async takePendingRefresh() {
        taken += 1;
        return null;
      },
    }),
  });

  await expect(process(parseJob())).rejects.toBeInstanceOf(DelayedError);
  expect(taken).toBe(0);
});

// The follow-up parse runs on intent already taken off the marker, and a
// deferred job retries from job.data -- so a deferral there has to write that
// intent into the job, or the retry parses the original request and a
// requested cache bypass is lost (#847).
test("a deferred follow-up keeps its consumed bypass until a retry fulfils it", async () => {
  const parsed: Array<[boolean | undefined, string | undefined]> = [];
  const outcomes = ["ok", "defer", "defer", "ok"];
  let pending: { skipCache: boolean } | null = { skipCache: true };
  let taken = 0;
  const { process } = await startWorker({
    feedParser: strictFake<FeedParser>({
      async parseSource(input) {
        parsed.push([input.skipCache, input.trigger]);
        if (outcomes.shift() === "defer") {
          throw new HttpDeferredError(Date.now() + 60_000);
        }
      },
    }),
    sourceEnqueuer: strictFake<SourceEnqueuer>({
      async takePendingRefresh() {
        taken += 1;
        const value = pending;
        pending = null;
        return value;
      },
    }),
  });

  // The order is the point: data written after the move would retry the
  // original request.
  const events: string[] = [];
  const deferrable: MainWorkerJob = job(
    JobName.ParseSource,
    { id: source.id, skipCache: false, url: source.url },
    {
      async moveToDelayed() {
        events.push("delay");
      },
      async updateData(data) {
        events.push("update");
        deferrable.data = data;
      },
    },
  );

  // The original request parses, the follow-up for the bypass defers.
  await expect(process(deferrable)).rejects.toBeInstanceOf(DelayedError);
  expect(events).toEqual(["update", "delay"]);
  expect(deferrable.data).toEqual({
    id: source.id,
    skipCache: true,
    trigger: "manual",
    url: source.url,
  });

  // Deferred again before finishing: the persisted bypass stays as it is.
  await expect(process(deferrable)).rejects.toBeInstanceOf(DelayedError);
  expect(events).toEqual(["update", "delay", "delay"]);

  // The retry fulfils the bypass once, with no further follow-up owed.
  await process(deferrable);
  expect(parsed).toEqual([
    [false, "poll"],
    [true, "manual"],
    [true, "manual"],
    [true, "manual"],
  ]);
  expect(taken).toBe(2);
  expect(events).toEqual(["update", "delay", "delay"]);
});

test("refreshes favicons only for validated job data", async () => {
  const refreshed: { homeUrl: string; id: number }[] = [];
  const { process } = await startWorker({
    faviconRefresher: strictFake<FaviconRefresher>({
      async refreshFavicon(value) {
        refreshed.push(value);
      },
    }),
  });

  await process(
    job(JobName.RefreshFavicon, { homeUrl: source.homeUrl, id: source.id }),
  );

  expect(refreshed).toEqual([{ homeUrl: source.homeUrl, id: source.id }]);
});

// A favicon run queues every due source at once, at a priority below the
// unprioritized ParseSource jobs, and finishes only once every add has.
test("queues every due favicon refresh concurrently, below feed parsing", async () => {
  const added = new Map<string, number | undefined>();
  const bothStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { process } = await startWorker({
    bullmqQueue: {
      async add(_name, _data, options) {
        added.set(options?.jobId ?? "", options?.priority);
        if (added.size === 2) bothStarted.resolve();
        await release.promise;
      },
      async addBulk() {},
      async upsertJobScheduler() {},
    },
    sourcesDataService: strictFake<SourcesDataService>({
      async getSourcesDueFaviconRefresh() {
        return [source, { ...source, id: 2 }];
      },
      async getSourcesToProcess() {
        return [];
      },
    }),
  });

  let finished = false;
  const processing = process(job(JobName.GatherFaviconJobs, {})).then(() => {
    finished = true;
  });
  // Both adds are in flight before either resolves.
  await bothStarted.promise;
  expect(Object.fromEntries(added)).toEqual({
    [`${JobName.RefreshFavicon}-1`]: 10,
    [`${JobName.RefreshFavicon}-2`]: 10,
  });
  expect(finished).toBe(false);

  release.resolve();
  await processing;
  expect(finished).toBe(true);
});

test("rejects malformed and unknown jobs before downstream calls", async () => {
  const downstreamCalls: string[] = [];
  const record =
    <T>(name: string, value: T) =>
    async () => {
      downstreamCalls.push(name);
      return value;
    };
  const { process } = await startWorker({
    bullmqQueue: {
      add: record("queue.add", undefined),
      addBulk: record("queue.addBulk", undefined),
      async upsertJobScheduler() {},
    },
    cleanupOrphanedData: record("cleanup", []),
    faviconRefresher: strictFake<FaviconRefresher>({
      refreshFavicon: record("refreshFavicon", undefined),
    }),
    feedParser: strictFake<FeedParser>({
      parseSource: record("parseSource", undefined),
    }),
    sourcesDataService: strictFake<SourcesDataService>({
      findSourceById: record("findSourceById", source),
      getSourcesDueFaviconRefresh: record("getSourcesDueFaviconRefresh", []),
      getSourcesToProcess: record("getSourcesToProcess", []),
    }),
    websubStateService: strictFake<WebSubStateService>({
      getWebSubSubscriptionsNeedingRenewal: record(
        "getWebSubSubscriptionsNeedingRenewal",
        [],
      ),
      markWebSubFailed: record("markWebSubFailed", undefined),
    }),
  });
  downstreamCalls.length = 0;

  await Promise.all(
    [
      job(JobName.Cleanup, { unexpected: true }),
      job(JobName.GatherFaviconJobs, null),
      job(JobName.GatherJobs, []),
      job(JobName.ParseSource, { id: source.id, url: "not a web URL" }),
      job(JobName.RefreshFavicon, { homeUrl: source.homeUrl, id: 1.5 }),
      job("unknown", {}),
    ].map(process),
  );

  expect(downstreamCalls).toEqual([]);
});

test("records a durable failure for non-ParseSource job errors", async () => {
  const recorded: [string, string][] = [];
  const { process } = await startWorker({
    async cleanupOrphanedData() {
      throw new Error("cleanup exploded");
    },
    jobFailuresDataService: strictFake<JobFailuresDataService>({
      async record(jobType, errorMessage) {
        recorded.push([jobType, errorMessage]);
      },
    }),
  });

  await process(job(JobName.Cleanup, {}));

  expect(recorded).toEqual([[JobName.Cleanup, "cleanup exploded"]]);
});

// The prune bypasses the services that own the unread badge, so the worker
// has to hand every source cleanup reports to the recompute itself (#812).
test("cleanup recounts the unread totals of every pruned source", async () => {
  const recounted: number[][] = [];
  const { process } = await startWorker({
    cleanupOrphanedData: async () => [7, 9],
    userSourcesDataService: strictFake<UserSourcesDataService>({
      async recomputeUnreadCounts(sourceIds) {
        recounted.push(sourceIds);
      },
    }),
  });

  await process(job(JobName.Cleanup, {}));

  expect(recounted).toEqual([[7, 9]]);
});

class PoisonedError extends Error {
  override get message(): string {
    throw new Error("message getter exploded");
  }
}

// Deliberately malformed: a real HttpDeferredError with a throwing getter,
// to prove the code under test survives a poisoned retryAt read. There's no
// type-safe way to construct that.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const poisonedDeferral = Object.create(HttpDeferredError.prototype, {
  retryAt: {
    get() {
      throw new Error("poisoned retryAt getter");
    },
  },
}) as HttpDeferredError;

// BullMQ must always see the job as acknowledged: whatever was thrown, and
// however the deferral or the failure record went wrong, the processor
// resolves.
test.each<[string, Partial<MainWorkerServices>, MainWorkerJob]>([
  [
    "a failure while recording a job failure",
    {
      async cleanupOrphanedData() {
        throw new Error("cleanup exploded");
      },
      jobFailuresDataService: strictFake<JobFailuresDataService>({
        async record() {
          throw new Error("database unavailable");
        },
      }),
    },
    job(JobName.Cleanup, {}),
  ],
  [
    "a poisoned error whose message getter throws",
    {
      async cleanupOrphanedData() {
        throw new PoisonedError();
      },
    },
    job(JobName.Cleanup, {}),
  ],
  [
    "an HttpDeferredError with a poisoned retryAt getter",
    {
      feedParser: strictFake<FeedParser>({
        async parseSource() {
          throw poisonedDeferral;
        },
      }),
    },
    parseJob({
      async moveToDelayed() {
        throw new Error("should never be called with a poisoned retryAt");
      },
    }),
  ],
  [
    "a moveToDelayed rejection (e.g. a real BullMQ/Redis failure)",
    { feedParser: deferredParser() },
    parseJob({
      async moveToDelayed() {
        throw new Error("Redis connection lost");
      },
    }),
  ],
  [
    "a moveToDelayed rejection with a poisoned prototype",
    { feedParser: deferredParser() },
    parseJob({
      async moveToDelayed() {
        throw new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("poisoned getPrototypeOf trap");
            },
          },
        );
      },
    }),
  ],
])("%s doesn't fail the job", async (_name, services, failing) => {
  const { process } = await startWorker(services);
  await expect(process(failing)).resolves.toBeUndefined();
});

// A deferral that cannot be moved is a failure like any other, recorded with
// what deferred it.
test("a deferral that cannot be moved is recorded as the job's failure", async () => {
  const recorded: [string, string][] = [];
  const { process } = await startWorker({
    feedParser: deferredParser(),
    jobFailuresDataService: strictFake<JobFailuresDataService>({
      async record(jobType, errorMessage) {
        recorded.push([jobType, errorMessage]);
      },
    }),
  });

  await process(
    parseJob({
      async moveToDelayed() {
        throw new Error("Redis connection lost");
      },
    }),
  );

  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.[0]).toBe(JobName.ParseSource);
  expect(recorded[0]?.[1]).toStartWith("Request deferred until ");
});

import type { AppConfig } from "#platform/config.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import type { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import { expect, setSystemTime, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { DelayedError } from "bullmq";
import { JobName } from "#shared/types/job-name-enum.ts";
import { HttpClient } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import {
  FaviconRefresher,
  faviconDeferralHorizonMs,
} from "#features/feeds/favicon-refresher.ts";
import { imageDimensions } from "#features/feeds/favicon-selection.ts";
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
  const refreshed: { firstRunAt: number; homeUrl: string; id: number }[] = [];
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

  expect(refreshed).toEqual([
    { firstRunAt: expect.any(Number), homeUrl: source.homeUrl, id: source.id },
  ]);
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

// A fake PNG header: enough for imageDimensions, and stored as-is because
// Bun.Image cannot decode it.
function fakePng(size: number) {
  const png = Buffer.alloc(24);
  png.write("\x89PNG", 0, "latin1");
  png.writeUInt32BE(size, 16);
  png.writeUInt32BE(size, 20);
  return png;
}

// What each provider answers on a normal day, with its real cache lifetime:
// gstatic the 64 px target, favicon.im 32 px behind a redirect to its own
// subdomain, DuckDuckGo 16 px.
function providerAnswer(
  url: string,
): [number, Record<string, string>, Buffer?] {
  const { hostname } = new URL(url);
  if (hostname === "favicon.im") {
    return [302, { location: url.replace("//favicon.im", "//a.favicon.im") }];
  }
  const [size, maxAge] =
    hostname === "t3.gstatic.com"
      ? [64, 7 * 86_400]
      : hostname === "a.favicon.im"
        ? [32, 8 * 86_400]
        : [16, 30 * 86_400];
  return [
    200,
    {
      "cache-control": `public, max-age=${maxAge}`,
      "content-type": "image/png",
    },
    fakePng(size),
  ];
}

// Plays a daily favicon gather through the real MainWorker, refresher, HTTP
// client, cache and limiter in virtual time, one job at a time. Each job
// starts up to 2 s after BullMQ hands it out, and every request takes
// 50-300 ms, both from a seeded generator so a failure replays exactly.
async function simulateFaviconGather(
  sourceCount: number,
  {
    answer = providerAnswer,
    redis = createFakeHttpRedis(),
    startAt = Date.parse("2026-10-30T00:00:00.000Z"),
  } = {},
) {
  let seed = 1_087;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const client = new HttpClient(redis, {
    deadlineMs: 2_000,
    transport: async (url) => {
      setSystemTime(Date.now() + 50 + Math.round(random() * 250));
      const [status, headers, data = Buffer.alloc(0)] = answer(url);
      const body = Readable.from([data]);
      return {
        body,
        destroy: () => body.destroy(),
        headers: new Headers(headers),
        status,
        url,
      };
    },
  });
  const updated = new Map<number, number | undefined>();
  // Each queued refresh and when BullMQ would next hand it to the worker.
  const queued: { data: unknown; runAt: number }[] = [];
  const { process } = await startWorker({
    bullmqQueue: {
      async add(_name, data, options) {
        queued.push({ data, runAt: Date.now() + (options?.delay ?? 0) });
      },
      async addBulk() {},
      async upsertJobScheduler() {},
    },
    faviconRefresher: new FaviconRefresher(
      client,
      {
        async updateFavicon(id, favicon) {
          updated.set(id, imageDimensions(favicon)?.width);
        },
      },
      redis,
    ),
    sourcesDataService: strictFake<SourcesDataService>({
      async getSourcesDueFaviconRefresh() {
        return Array.from({ length: sourceCount }, (_, index) => ({
          homeUrl: `https://site${index + 1}.example/`,
          id: index + 1,
        }));
      },
      async getSourcesToProcess() {
        return [];
      },
    }),
  });

  setSystemTime(startAt);
  let runs = 0;
  try {
    await process(job(JobName.GatherFaviconJobs, {}));
    /* eslint-disable no-await-in-loop -- Jobs run one at a time in virtual time. */
    for (;;) {
      queued.sort((a, b) => a.runAt - b.runAt);
      const next = queued.shift();
      // A refresh still queued at the next daily gather is one too many.
      if (!next || next.runAt > startAt + 86_400_000) break;
      setSystemTime(
        Math.max(next.runAt + Math.round(random() * 2_000), Date.now()),
      );
      runs++;
      let { data } = next;
      await process(
        job(JobName.RefreshFavicon, data, {
          async moveToDelayed(timestamp) {
            queued.push({ data, runAt: timestamp });
          },
          async updateData(value) {
            data = value;
          },
        }),
      ).catch((error: unknown) => {
        if (!(error instanceof DelayedError)) throw error;
      });
    }
    /* eslint-enable no-await-in-loop */
    return { finishedAt: Date.now(), runs, updated };
  } finally {
    setSystemTime();
  }
}

// Every refresh asks the same provider hosts, and the limiter lets each take
// one background request per interval. Deferred jobs must queue for slots of
// their own: woken together, each slot would go to one job and re-defer all
// the others, about N²/6 runs (#1087).
test("a cold favicon run takes about two runs per source, and a warm one one", async () => {
  const redis = createFakeHttpRedis();
  const cold = await simulateFaviconGather(1_000, { redis });
  expect(cold.updated.size).toBe(1_000);
  expect([...cold.updated.values()].every((size) => size === 64)).toBe(true);
  expect(cold.runs).toBeLessThanOrEqual(2_000);

  const warm = await simulateFaviconGather(1_000, {
    redis,
    startAt: Date.parse("2026-10-31T00:00:00.000Z"),
  });
  expect(warm.updated.size).toBe(1_000);
  expect(warm.runs).toBe(1_000);
});

test("a provider that never stops deferring holds icons back only until the horizon", async () => {
  const startAt = Date.parse("2026-10-30T00:00:00.000Z");
  const { finishedAt, runs, updated } = await simulateFaviconGather(100, {
    answer: (url) =>
      url.includes("gstatic")
        ? [429, { "retry-after": "60" }]
        : providerAnswer(url),
    startAt,
  });

  expect(updated.size).toBe(100);
  expect([...updated.values()].every((size) => size === 32)).toBe(true);
  expect(finishedAt).toBeLessThan(
    startAt + faviconDeferralHorizonMs + 3_600_000,
  );
  expect(runs).toBeLessThanOrEqual(1_000);
});

test("an hour-long provider block queues the refreshes instead of waking them together", async () => {
  const startAt = Date.parse("2026-10-30T00:00:00.000Z");
  const { runs, updated } = await simulateFaviconGather(500, {
    answer: (url) =>
      url.includes("gstatic") && Date.now() < startAt + 3_600_000
        ? [429, { "retry-after": "3600" }]
        : providerAnswer(url),
    startAt,
  });

  expect(updated.size).toBe(500);
  expect([...updated.values()].every((size) => size === 64)).toBe(true);
  expect(runs).toBeLessThanOrEqual(1_000);
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
// however the deferral or the log call went wrong, the processor resolves --
// and logs what the job originally threw, which proves each case reached the
// path it names rather than failing earlier on an unexpected call.
const failure = new Error("cleanup exploded");
const poisonedError = new PoisonedError();
const deferral = new HttpDeferredError(Date.now() + 60_000);
const throwsDeferral = strictFake<FeedParser>({
  async parseSource() {
    throw deferral;
  },
});
test.each<[string, Partial<MainWorkerServices>, MainWorkerJob, unknown]>([
  [
    "a plain job error",
    {
      async cleanupOrphanedData() {
        throw failure;
      },
    },
    job(JobName.Cleanup, {}),
    failure,
  ],
  [
    "a poisoned error whose message getter throws",
    {
      async cleanupOrphanedData() {
        throw poisonedError;
      },
    },
    job(JobName.Cleanup, {}),
    poisonedError,
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
    poisonedDeferral,
  ],
  [
    "a moveToDelayed rejection (e.g. a real BullMQ/Redis failure)",
    { feedParser: throwsDeferral },
    parseJob({
      async moveToDelayed() {
        throw new Error("Redis connection lost");
      },
    }),
    deferral,
  ],
  [
    "a moveToDelayed rejection with a poisoned prototype",
    { feedParser: throwsDeferral },
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
    deferral,
  ],
])("%s doesn't fail the job", async (_name, services, failing, thrown) => {
  const { process } = await startWorker(services);
  using logged = spyOn(console, "error").mockImplementation(() => {});
  await expect(process(failing)).resolves.toBeUndefined();
  expect(logged.mock.calls).toHaveLength(1);
  expect(logged.mock.calls[0]?.[0]).toBe(
    `Error processing ${failing.name} job:`,
  );
  // toBe, not toEqual: comparing a poisoned value would read its getters.
  expect(logged.mock.calls[0]?.[1]).toBe(thrown);
});

import type { AppConfig } from "#platform/config.ts";
import { JobName } from "#features/feeds/queued-job.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { RetentionService } from "#features/feeds/retention.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { WebSubSubscriber } from "#features/feeds/websub-subscriber.ts";
import { expect, setSystemTime, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { DelayedError } from "bullmq";
import { HttpClient } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import {
  FaviconRefresher,
  faviconDeferralHorizonMs,
} from "#features/feeds/favicon-refresher.ts";
import { imageDimensions } from "#features/feeds/favicon-selection.ts";
import {
  pendingParseRefreshKey,
  SourceEnqueuer,
  type SourceParseQueue,
  type SourceParseRedis,
} from "#features/feeds/source-enqueue.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import {
  type WorkerReply,
  workerRequestTimeoutMs,
} from "#platform/worker-requests.ts";
import { HttpDeadlineError } from "#platform/http/request-deadline.ts";
import {
  MainWorker,
  type MainWorkerJob,
  type MainWorkerServices,
  type WorkerRequestJob,
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
  reservedBy: null,
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

const pendingKey = pendingParseRefreshKey(source.id);

const enqueuerWithMarker = (marker?: string) => {
  const redis = new Map<string, string>();
  if (marker !== undefined) redis.set(pendingKey, marker);
  const enqueuer = new SourceEnqueuer(
    strictFake<SourceParseQueue>({ async addBulk() {} }, "parseQueue"),
    strictFake<SourceParseRedis>(
      {
        async getdel(key) {
          const value = redis.get(key) ?? null;
          redis.delete(key);
          return value;
        },
      },
      "parseRedis",
    ),
  );
  return { enqueuer, redis };
};

async function startWorker(overrides: Partial<MainWorkerServices> = {}) {
  let processor: ((job: MainWorkerJob) => Promise<void>) | undefined;
  let answer: ((job: WorkerRequestJob) => Promise<WorkerReply>) | undefined;
  const worker = new MainWorker({
    bullmqQueue: {
      async upsertJobScheduler() {},
    },
    config,
    createRequestWorker(value) {
      answer = value;
      return idleJobWorker;
    },
    faviconRefresher: strictFake<FaviconRefresher>({}, "faviconRefresher"),
    feedParser: strictFake<FeedParser>(
      { async parseSource() {} },
      "feedParser",
    ),
    jobHandlers: new Map(),
    requestHandlers: new Map(),
    retentionService: strictFake<RetentionService>({}, "retentionService"),
    sourceEnqueuer: enqueuerWithMarker().enqueuer,
    sourcesDataService: idleSources(),
    webSubSubscriber: strictFake<WebSubSubscriber>({}, "webSubSubscriber"),
    ...overrides,
    createWorker(value, options) {
      processor = value;
      return (overrides.createWorker ?? (() => idleJobWorker))(value, options);
    },
  });
  await worker.initialize();
  if (!processor || !answer)
    throw new Error("Worker processor was not captured");
  return { answer, process: processor, worker };
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
  job(JobName.ParseSource, { id: source.id }, overrides);

const deferredParser = (retryAt = Date.now() + 60_000) =>
  strictFake<FeedParser>({
    async parseSource() {
      throw new HttpDeferredError(retryAt);
    },
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

  await process(job(JobName.ParseSource, { id: source.id, skipCache: true }));

  expect(parsedSource).toEqual({
    ...source,
    skipCache: true,
  });
});

test("a queued email source is not fetched", async () => {
  let parsed = false;
  const { process } = await startWorker({
    feedParser: strictFake<FeedParser>({
      async parseSource() {
        parsed = true;
      },
    }),
    sourcesDataService: strictFake<SourcesDataService>({
      async findSourceById() {
        return { ...source, kind: "email", url: "abc@mail.example" };
      },
      async getSourcesToProcess() {
        return [];
      },
    }),
  });

  await process(parseJob());

  expect(parsed).toBe(false);
});

test("a job a feature registered runs its handler, and a handler failure is logged and acknowledged", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const handled: unknown[] = [];
  const { process } = await startWorker({
    jobHandlers: new Map([
      [
        "REFRESH_SOURCES",
        async (data: unknown) => {
          handled.push(data);
        },
      ],
      [
        "BROKEN",
        async () => {
          throw new Error("redis is down");
        },
      ],
    ]),
  });

  let logged = 0;
  try {
    await process(job("REFRESH_SOURCES", { ids: [source.id] }));
    await process(job("BROKEN", {}));
    logged = errors.mock.calls.length;
  } finally {
    errors.mockRestore();
  }

  expect(handled).toEqual([{ ids: [source.id] }]);
  expect(logged).toBe(1);
});

const newsletter = {
  ...source,
  id: 2,
  kind: "email" as const,
  url: "abc@mail.example",
};

test("a WebSub discovery job probes the stored feed and skips newsletters", async () => {
  const probed: unknown[][] = [];
  const stored = new Map<number, typeof source | typeof newsletter>([
    [source.id, source],
    [newsletter.id, newsletter],
  ]);
  const { process } = await startWorker({
    feedParser: strictFake<FeedParser>({
      async discoverAndSubscribeWebSub(...args) {
        probed.push(args);
      },
    }),
    sourcesDataService: strictFake<SourcesDataService>({
      async findSourceById(id) {
        return stored.get(id);
      },
      async getSourcesToProcess() {
        return [];
      },
    }),
  });

  await process(job(JobName.DiscoverWebSub, { id: source.id }));
  await process(job(JobName.DiscoverWebSub, { id: 2 }));
  await process(job(JobName.DiscoverWebSub, { id: 3 }));

  expect(probed).toEqual([[source.id, source.url, source.websubStatus]]);
});

const request = (name: string, data: unknown, timestamp = Date.now()) => ({
  data,
  name,
  timestamp,
});

test("the request worker answers with the handler's value or its no-answer error", async () => {
  const retryAt = Date.now() + 30_000;
  const { answer } = await startWorker({
    requestHandlers: new Map([
      ["echo", async (data: unknown) => ({ echoed: data })],
      [
        "deferred",
        async () => {
          throw new HttpDeferredError(retryAt);
        },
      ],
      [
        "deadline",
        async () => {
          throw new HttpDeadlineError(30_000);
        },
      ],
    ]),
  });

  expect(await answer(request("echo", { a: 1 }))).toEqual({
    value: { echoed: { a: 1 } },
  });
  expect(await answer(request("deferred", {}))).toEqual({
    deferredUntil: retryAt,
  });
  expect(await answer(request("deadline", {}))).toEqual({ deadlineMs: 30_000 });
});

test("the request worker acknowledges failures, unknown requests and expired requests", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const ran: string[] = [];
  try {
    const { answer } = await startWorker({
      requestHandlers: new Map([
        [
          "broken",
          async () => {
            throw new PoisonedError();
          },
        ],
        [
          "late",
          async () => {
            ran.push("late");
            return {};
          },
        ],
      ]),
    });

    const replies = await Promise.all([
      answer(request("broken", {})),
      answer(request("missing", {})),
      answer(request("late", {}, Date.now() - workerRequestTimeoutMs - 1)),
    ]);

    expect(replies).toEqual([
      { failed: true },
      { failed: true },
      { failed: true },
    ]);
    expect(ran).toEqual([]);
  } finally {
    errors.mockRestore();
  }
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

test("folds a refresh waiting on the marker into the parse", async () => {
  const parsed: Array<[boolean | undefined, string | undefined]> = [];
  const { process } = await startWorker({
    feedParser: strictFake<FeedParser>({
      async parseSource(input) {
        parsed.push([input.skipCache, input.trigger]);
      },
    }),
    sourceEnqueuer: enqueuerWithMarker("1").enqueuer,
  });

  await process(parseJob());

  expect(parsed).toEqual([[true, "manual"]]);
});

test("a deferred parse keeps the refresh it took until a retry fulfils it", async () => {
  const parsed: Array<[boolean | undefined, string | undefined]> = [];
  const outcomes = ["defer", "defer", "ok"];
  const { enqueuer } = enqueuerWithMarker("1");
  const { process } = await startWorker({
    feedParser: strictFake<FeedParser>({
      async parseSource(input) {
        parsed.push([input.skipCache, input.trigger]);
        if (outcomes.shift() === "defer") {
          throw new HttpDeferredError(Date.now() + 60_000);
        }
      },
    }),
    sourceEnqueuer: enqueuer,
  });

  const events: string[] = [];
  const deferrable: MainWorkerJob = job(
    JobName.ParseSource,
    { id: source.id, skipCache: false },
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

  await expect(process(deferrable)).rejects.toBeInstanceOf(DelayedError);
  expect(events).toEqual(["update", "delay"]);
  expect(deferrable.data).toEqual({
    id: source.id,
    skipCache: true,
    trigger: "manual",
  });

  await expect(process(deferrable)).rejects.toBeInstanceOf(DelayedError);
  expect(events).toEqual(["update", "delay", "delay"]);

  await process(deferrable);
  expect(parsed).toEqual([
    [true, "manual"],
    [true, "manual"],
    [true, "manual"],
  ]);
  expect(events).toEqual(["update", "delay", "delay"]);
});

function fakePng(size: number) {
  const png = Buffer.alloc(24);
  png.write("\x89PNG", 0, "latin1");
  png.writeUInt32BE(size, 16);
  png.writeUInt32BE(size, 20);
  return png;
}

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
  const queued: { data: unknown; runAt: number }[] = [];
  const { process } = await startWorker({
    faviconRefresher: new FaviconRefresher(
      client,
      {
        async updateFavicon(id, favicon) {
          updated.set(id, imageDimensions(favicon)?.width);
        },
      },
      redis,
      {
        async addBulk(jobs) {
          for (const { data } of jobs) queued.push({ data, runAt: Date.now() });
        },
      },
    ),
    sourcesDataService: strictFake<SourcesDataService>({
      async getSourcesDueFaviconRefresh() {
        return Array.from({ length: sourceCount }, (_, index) => ({
          hasFavicon: false,
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
    return { finishedAt: Date.now(), pending: queued.length, runs, updated };
  } finally {
    setSystemTime();
  }
}

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

test("a provider that always answers 429 with a short Retry-After lets every refresh complete", async () => {
  const startAt = Date.parse("2026-10-30T00:00:00.000Z");
  const { finishedAt, pending, updated } = await simulateFaviconGather(100, {
    answer: (url) =>
      url.includes("gstatic")
        ? [429, { "retry-after": "5" }]
        : providerAnswer(url),
    startAt,
  });

  expect(pending).toBe(0);
  expect(finishedAt).toBeLessThan(
    startAt + faviconDeferralHorizonMs + 3_600_000,
  );
  expect(updated.size).toBe(100);
  expect([...updated.values()].every((size) => size === 32)).toBe(true);
});

test("a short provider block late in a cold run does not downgrade icons", async () => {
  const startAt = Date.parse("2026-10-30T00:00:00.000Z");
  let blocked = false;
  const { pending, updated } = await simulateFaviconGather(1_000, {
    answer: (url) => {
      if (
        url.includes("gstatic") &&
        !blocked &&
        Date.now() > startAt + 3 * 3_600_000
      ) {
        blocked = true;
        return [429, {}];
      }
      return providerAnswer(url);
    },
    startAt,
  });

  expect(pending).toBe(0);
  expect(updated.size).toBe(1_000);
  expect([...updated.values()].every((size) => size === 64)).toBe(true);
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
    faviconRefresher: strictFake<FaviconRefresher>({
      enqueueRefreshes: record("enqueueRefreshes", undefined),
      refreshFavicon: record("refreshFavicon", undefined),
    }),
    feedParser: strictFake<FeedParser>({
      parseSource: record("parseSource", undefined),
    }),
    retentionService: strictFake<RetentionService>({
      prune: record("prune", undefined),
    }),
    sourcesDataService: strictFake<SourcesDataService>({
      findSourceById: record("findSourceById", source),
      getSourcesDueFaviconRefresh: record("getSourcesDueFaviconRefresh", []),
      getSourcesToProcess: record("getSourcesToProcess", []),
    }),
    webSubSubscriber: strictFake<WebSubSubscriber>({
      renewDue: record("renewDue", undefined),
    }),
  });
  downstreamCalls.length = 0;

  await Promise.all(
    [
      job(JobName.Cleanup, { unexpected: true }),
      job(JobName.GatherFaviconJobs, null),
      job(JobName.GatherJobs, []),
      job(JobName.ParseSource, { id: 0 }),
      job(JobName.RefreshFavicon, { homeUrl: source.homeUrl, id: 1.5 }),
      job("unknown", {}),
    ].map(process),
  );

  expect(downstreamCalls).toEqual([]);
});

class PoisonedError extends Error {
  override get message(): string {
    throw new Error("message getter exploded");
  }
}

class PoisonedDeferral extends HttpDeferredError {
  constructor() {
    super(0);
    Object.defineProperty(this, "retryAt", {
      get() {
        throw new Error("poisoned retryAt getter");
      },
    });
  }
}

const poisonedDeferral = new PoisonedDeferral();

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
      retentionService: strictFake<RetentionService>({
        async prune() {
          throw failure;
        },
      }),
    },
    job(JobName.Cleanup, {}),
    failure,
  ],
  [
    "a poisoned error whose message getter throws",
    {
      retentionService: strictFake<RetentionService>({
        async prune() {
          throw poisonedError;
        },
      }),
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
  expect(logged.mock.calls[0]?.[1]).toBe(thrown);
});

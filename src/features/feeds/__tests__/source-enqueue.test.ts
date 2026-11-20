import { describe, expect, test } from "bun:test";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { JobDeferral, JobName } from "#features/feeds/queued-job.ts";
import {
  type ParseRequest,
  type SourceParseJobHandle,
  type SourceParseQueue,
  type SourceParseRedis,
  parseSourceJobId,
  pendingParseRefreshKey,
  SourceEnqueuer,
} from "#features/feeds/source-enqueue.ts";

const fakeRedis = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial));
  const redis: SourceParseRedis = {
    async eval() {
      return 1;
    },
    async getdel(key) {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
    async set(key, value, mode) {
      if (mode === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
  };
  return redis;
};

const holderFor = (state: string): SourceParseJobHandle => ({
  async getState() {
    return state;
  },
});

const parsesOf = async (enqueuer: SourceEnqueuer) => {
  const parsed: ParseRequest[] = [];
  await enqueuer.runParse({ id: 3 }, async (request) => {
    parsed.push(request);
  });
  return parsed;
};

describe("SourceEnqueuer", () => {
  const source = { id: 3, url: "https://example.test/feed" };
  const jobId = parseSourceJobId(source.id);
  const pendingKey = pendingParseRefreshKey(source.id);

  const fakeQueue = (holder: SourceParseJobHandle | null = null) => {
    const adds: unknown[] = [];
    const queue: SourceParseQueue = {
      async add(name, data, options) {
        adds.push([name, data, options]);
        return undefined;
      },
      async addBulk(jobs) {
        adds.push(...jobs.map(({ data, name, opts }) => [name, data, opts]));
        return undefined;
      },
      async getJob(id) {
        expect(id).toBe(jobId);
        return holder;
      },
      toKey(name) {
        return `bull:tasks:${name}`;
      },
    };
    return { adds, queue };
  };

  test("adds directly when no job holds the source's id", async () => {
    const { queue, adds } = fakeQueue(null);
    const redis = fakeRedis();
    const enqueuer = new SourceEnqueuer(queue, redis);

    await enqueuer.enqueueSource(source);

    expect(adds).toEqual([
      [
        JobName.ParseSource,
        { id: 3, skipCache: true, trigger: "manual" },
        {
          jobId,
          lifo: true,
          removeOnComplete: { count: 0 },
          removeOnFail: { count: 0 },
        },
      ],
    ]);
    expect(await parsesOf(enqueuer)).toEqual([{ id: 3 }]);
  });

  test.each([
    [[false], { skipCache: false }],
    [[false, true], { skipCache: true }],
    [[true, false], { skipCache: true }],
  ])(
    "requests %p on a running job leave the follow-up %p",
    async (skipCaches, followUp) => {
      const { queue, adds } = fakeQueue(holderFor("active"));
      const enqueuer = new SourceEnqueuer(queue, fakeRedis());

      for (const skipCache of skipCaches) {
        // eslint-disable-next-line no-await-in-loop -- Arrival order is the case.
        await enqueuer.enqueueSource(source, "websub-push", skipCache);
      }

      expect(adds).toEqual([]);
      expect(await parsesOf(enqueuer)).toEqual([
        { id: source.id },
        { id: source.id, ...followUp, trigger: "manual" },
      ]);
    },
  );

  test("adds a refresh if the queued job disappeared before merging", async () => {
    const { queue, adds } = fakeQueue(holderFor("waiting"));
    const redis = fakeRedis();
    redis.eval = async () => 0;

    await new SourceEnqueuer(queue, redis).enqueueSource(source);

    expect(adds).toHaveLength(1);
  });

  test("a run answers the requests that piled up during it once", async () => {
    const { queue } = fakeQueue(null);
    const redis = fakeRedis({ [pendingKey]: "1" });
    const enqueuer = new SourceEnqueuer(queue, redis);

    expect(await parsesOf(enqueuer)).toEqual([
      { id: source.id },
      { id: source.id, skipCache: true, trigger: "manual" },
    ]);
    expect(await parsesOf(enqueuer)).toEqual([{ id: source.id }]);
  });

  test("a deferred follow-up hands its intent to the retry", async () => {
    const { queue } = fakeQueue(null);
    const redis = fakeRedis({ [pendingKey]: "1" });
    const enqueuer = new SourceEnqueuer(queue, redis);
    const retryAt = Date.now() + 60_000;

    const run = enqueuer.runParse(
      { id: source.id, skipCache: false },
      async (request) => {
        if (request.trigger === "manual") throw new HttpDeferredError(retryAt);
      },
    );

    const deferral = await run.catch((error: unknown) => error);
    expect(deferral).toBeInstanceOf(JobDeferral);
    expect(deferral).toMatchObject({
      data: { id: source.id, skipCache: true, trigger: "manual" },
      retryAt,
    });
  });

  test("queues each due source behind explicit requests", async () => {
    const { queue, adds } = fakeQueue(null);
    await new SourceEnqueuer(queue, fakeRedis()).enqueueDueSources([source]);
    expect(adds).toEqual([
      [
        JobName.ParseSource,
        { id: source.id },
        { jobId, removeOnComplete: { count: 0 }, removeOnFail: { count: 0 } },
      ],
    ]);
  });
});

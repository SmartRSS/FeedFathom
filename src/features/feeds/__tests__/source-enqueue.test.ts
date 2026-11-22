import { describe, expect, test } from "bun:test";
import { JobName } from "#features/feeds/queued-job.ts";
import {
  type ParseRequest,
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

  const fakeQueue = () => {
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
        return null;
      },
      toKey(name) {
        return `bull:tasks:${name}`;
      },
    };
    return { adds, queue };
  };

  test("adds directly when no job holds the source's id", async () => {
    const { queue, adds } = fakeQueue();
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

  test("a run answers the requests that piled up during it once", async () => {
    const { queue } = fakeQueue();
    const redis = fakeRedis({ [pendingKey]: "1" });
    const enqueuer = new SourceEnqueuer(queue, redis);

    expect(await parsesOf(enqueuer)).toEqual([
      { id: source.id },
      { id: source.id, skipCache: true, trigger: "manual" },
    ]);
    expect(await parsesOf(enqueuer)).toEqual([{ id: source.id }]);
  });

  test("queues each due source behind explicit requests", async () => {
    const { queue, adds } = fakeQueue();
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

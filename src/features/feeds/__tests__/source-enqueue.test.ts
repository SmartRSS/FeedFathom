import { describe, expect, test } from "bun:test";
import { JobName } from "#shared/types/job-name-enum.ts";
import {
  type SourceParseJobHandle,
  type SourceParseQueue,
  type SourceParseRedis,
  SourceEnqueuer,
} from "#features/feeds/source-enqueue.ts";

// The per-source job id is BullMQ's dedupe key, so how the enqueuer treats a
// source whose job already exists is the whole feature (#813): a request that
// lands on a running job must be answered with a follow-up, and one that
// lands on a queued poll must still refresh like it asked.
describe("SourceEnqueuer", () => {
  const source = { id: 3, url: "https://example.test/feed" };
  const jobId = `${JobName.ParseSource}-${source.id}`;
  const pendingKey = `pending_parse_refresh:${source.id}`;

  const fakeRedis = (initial: Record<string, string> = {}) => {
    const store = new Map(Object.entries(initial));
    const sets: [string, string, string | undefined][] = [];
    const dels: string[] = [];
    const evaluations: unknown[][] = [];
    const redis: SourceParseRedis = {
      async eval(...args) {
        evaluations.push(args);
        return 1;
      },
      async getdel(key) {
        dels.push(key);
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      },
      async set(key, value, mode) {
        sets.push([key, value, mode]);
        if (mode === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
    };
    return { dels, evaluations, redis, sets };
  };

  const fakeQueue = (holder: SourceParseJobHandle | null = null) => {
    const adds: unknown[] = [];
    const queue: SourceParseQueue = {
      async add(name, data, options) {
        adds.push([name, data, options]);
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

  const holderFor = (state: string): SourceParseJobHandle => ({
    async getState() {
      return state;
    },
  });

  test("adds directly when no job holds the source's id", async () => {
    const { queue, adds } = fakeQueue(null);
    const { redis, sets } = fakeRedis();
    const enqueuer = new SourceEnqueuer(queue, redis);

    await enqueuer.enqueueSource(source);

    expect(adds).toEqual([
      [
        JobName.ParseSource,
        { id: 3, skipCache: true, trigger: "manual", url: source.url },
        {
          jobId,
          lifo: true,
          removeOnComplete: { count: 0 },
          removeOnFail: { count: 0 },
        },
      ],
    ]);
    expect(sets).toEqual([]);
  });

  test("records a request that lands on a running job instead of adding", async () => {
    const { queue, adds } = fakeQueue(holderFor("active"));
    const { redis, sets } = fakeRedis();
    const enqueuer = new SourceEnqueuer(queue, redis);

    await enqueuer.enqueueSource(source, "websub-push", false);

    expect(adds).toEqual([]);
    expect(sets).toEqual([[pendingKey, "0", "NX"]]);
  });

  test("a cache bypass dominates whatever is already pending", async () => {
    const { queue } = fakeQueue(holderFor("active"));
    const { redis, sets } = fakeRedis({ [pendingKey]: "0" });
    const enqueuer = new SourceEnqueuer(queue, redis);

    await enqueuer.enqueueSource(source);

    expect(sets).toEqual([[pendingKey, "1", undefined]]);
  });

  for (const state of ["waiting", "delayed"]) {
    test(`merges a ${state} refresh atomically without adding another job`, async () => {
      const { queue, adds } = fakeQueue(holderFor(state));
      const { redis, dels, evaluations } = fakeRedis();
      const enqueuer = new SourceEnqueuer(queue, redis);

      await enqueuer.enqueueSource(source);

      expect(adds).toEqual([]);
      expect(dels).toEqual([]);
      expect(evaluations).toEqual([
        [
          expect.any(String),
          5,
          `bull:tasks:${jobId}`,
          pendingKey,
          "bull:tasks:wait",
          "bull:tasks:paused",
          "bull:tasks:delayed",
          jobId,
          JSON.stringify({
            id: 3,
            skipCache: true,
            trigger: "manual",
            url: source.url,
          }),
        ],
      ]);
    });
  }

  test("adds a refresh if the queued job disappeared before merging", async () => {
    const { queue, adds } = fakeQueue(holderFor("waiting"));
    const { redis } = fakeRedis();
    redis.eval = async () => 0;

    await new SourceEnqueuer(queue, redis).enqueueSource(source);

    expect(adds).toHaveLength(1);
  });

  test("takePendingRefresh coalesces to one request, or none", async () => {
    const { queue } = fakeQueue(null);
    const { redis } = fakeRedis({ [pendingKey]: "1" });
    const enqueuer = new SourceEnqueuer(queue, redis);

    expect(await enqueuer.takePendingRefresh(source.id)).toEqual({
      skipCache: true,
    });
    // The take is the consume: the same burst cannot be answered twice.
    expect(await enqueuer.takePendingRefresh(source.id)).toBeNull();
    expect(await enqueuer.takePendingRefresh(999)).toBeNull();
  });
});

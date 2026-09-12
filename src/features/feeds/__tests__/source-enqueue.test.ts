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
    const redis: SourceParseRedis = {
      async get(key) {
        return store.get(key) ?? null;
      },
      async set(key, value, mode) {
        sets.push([key, value, mode]);
        if (mode === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      async getdel(key) {
        dels.push(key);
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      },
    };
    return { redis, sets, dels };
  };

  const fakeQueue = (holder: SourceParseJobHandle | null = null) => {
    const adds: unknown[] = [];
    const queue: SourceParseQueue = {
      async getJob(id) {
        expect(id).toBe(jobId);
        return holder;
      },
      async add(name, data, options) {
        adds.push([name, data, options]);
        return undefined;
      },
    };
    return { queue, adds };
  };

  const holderFor = (
    data: SourceParseJobHandle["data"],
    state: string,
  ): SourceParseJobHandle & { updatesMade: unknown[] } => {
    const updatesMade: unknown[] = [];
    return {
      data,
      async getState() {
        return state;
      },
      async updateData(next) {
        updatesMade.push(next);
      },
      updatesMade,
    };
  };

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
    const { queue, adds } = fakeQueue(holderFor({ id: 3 }, "active"));
    const { redis, sets } = fakeRedis();
    const enqueuer = new SourceEnqueuer(queue, redis);

    await enqueuer.enqueueSource(source, "websub-push", false);

    expect(adds).toEqual([]);
    expect(sets).toEqual([[pendingKey, "0", "NX"]]);
  });

  test("a cache bypass dominates whatever is already pending", async () => {
    const { queue } = fakeQueue(holderFor({ id: 3 }, "active"));
    const { redis, sets } = fakeRedis({ [pendingKey]: "0" });
    const enqueuer = new SourceEnqueuer(queue, redis);

    await enqueuer.enqueueSource(source);

    expect(sets).toEqual([[pendingKey, "1", undefined]]);
  });

  test("folds the request into a queued poll's payload so one fetch runs", async () => {
    const holder = holderFor({ id: 3, url: source.url }, "waiting");
    const { queue, adds } = fakeQueue(holder);
    const { redis, dels } = fakeRedis({ [pendingKey]: "0" });
    const enqueuer = new SourceEnqueuer(queue, redis);

    // Manual refresh: bypass the cache even though the pending marker said
    // the earlier request was happy to use it.
    await enqueuer.enqueueSource(source, "manual", true);

    expect(adds).toEqual([]);
    expect(dels).toEqual([pendingKey]);
    expect(holder.updatesMade).toEqual([
      { id: 3, skipCache: true, trigger: "manual", url: source.url },
    ]);
  });

  test("a delayed job (rate-limit retry) gets the fresh payload too", async () => {
    const holder = holderFor({ id: 3, url: source.url }, "delayed");
    const { queue } = fakeQueue(holder);
    const { redis } = fakeRedis();
    const enqueuer = new SourceEnqueuer(queue, redis);

    await enqueuer.enqueueSource(source);

    expect(holder.updatesMade).toEqual([
      { id: 3, skipCache: true, trigger: "manual", url: source.url },
    ]);
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

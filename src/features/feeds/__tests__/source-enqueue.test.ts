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
const fakeRedis = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial));
  const sets: [string, string, string | undefined][] = [];
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
      sets.push([key, value, mode]);
      if (mode === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
  };
  return { redis, sets };
};

const holderFor = (state: string): SourceParseJobHandle => ({
  async getState() {
    return state;
  },
});

describe("SourceEnqueuer", () => {
  const source = { id: 3, url: "https://example.test/feed" };
  const jobId = `${JobName.ParseSource}-${source.id}`;
  const pendingKey = `pending_parse_refresh:${source.id}`;

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

  // A request landing on a running job is answered by one follow-up once the
  // job finishes; a cache bypass wins over a plain refresh in either order.
  // Merging into a waiting or delayed job runs against real Redis in
  // source-enqueue-integration.test.ts.
  test.each([
    [[false], { skipCache: false }],
    [[false, true], { skipCache: true }],
    [[true, false], { skipCache: true }],
  ])(
    "requests %p on a running job leave the follow-up %p",
    async (skipCaches, followUp) => {
      const { queue, adds } = fakeQueue(holderFor("active"));
      const enqueuer = new SourceEnqueuer(queue, fakeRedis().redis);

      for (const skipCache of skipCaches) {
        // eslint-disable-next-line no-await-in-loop -- Arrival order is the case.
        await enqueuer.enqueueSource(source, "websub-push", skipCache);
      }

      expect(adds).toEqual([]);
      expect(await enqueuer.takePendingRefresh(source.id)).toEqual(followUp);
    },
  );

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

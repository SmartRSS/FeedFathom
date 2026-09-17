import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Job, Queue } from "bullmq";
import Redis from "ioredis";
import { JobName } from "#shared/types/job-name-enum.ts";
import { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import { requireDisposableRedisUrl } from "./disposable-redis-url.ts";

describe("queued refresh merging with BullMQ", () => {
  const connection = new Redis(requireDisposableRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(`source-enqueue-test-${crypto.randomUUID()}`, {
    connection,
  });
  const source = {
    id: 1 + Math.floor(Math.random() * 2_000_000_000),
    url: "https://example.test/feed",
  };
  const jobId = `${JobName.ParseSource}-${source.id}`;
  const pendingKey = `pending_parse_refresh:${source.id}`;
  const enqueuer = new SourceEnqueuer(queue, connection);

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await connection.del(pendingKey);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await connection.del(pendingKey);
    await queue.close();
    await connection.quit();
  });

  for (const delay of [0, 60_000]) {
    for (const existing of [undefined, false, true]) {
      for (const incoming of [false, true]) {
        for (const pending of [null, "0", "1"]) {
          test(`merges delay=${delay} existing=${existing} incoming=${incoming} pending=${pending}`, async () => {
            await queue.add(
              JobName.ParseSource,
              {
                ...source,
                ...(existing === undefined ? {} : { skipCache: existing }),
              },
              { delay, jobId },
            );
            if (pending !== null) await connection.set(pendingKey, pending);

            await enqueuer.enqueueSource(source, "websub-push", incoming);

            const job = await queue.getJob(jobId);
            expect(job?.data.skipCache).toBe(
              existing === true || incoming || pending === "1",
            );
            expect(await job?.getState()).toBe(delay ? "delayed" : "waiting");
            expect(await queue.getJobCountByTypes("waiting", "delayed")).toBe(
              1,
            );
            expect(await enqueuer.takePendingRefresh(source.id)).toBeNull();
          });
        }
      }
    }

    test(`stale handles cannot downgrade a concurrent bypass with delay=${delay}`, async () => {
      await queue.add(JobName.ParseSource, source, { delay, jobId });
      const stale = await Job.fromId(queue, jobId);
      if (!stale) throw new Error("Queued job was not found");
      const staleQueue = {
        add: queue.add.bind(queue),
        async getJob() {
          return stale;
        },
        toKey: queue.toKey,
      };
      const cacheEligible = new SourceEnqueuer(staleQueue, connection);

      await enqueuer.enqueueSource(source);
      await Promise.all([
        cacheEligible.enqueueSource(source, "websub-push", false),
        cacheEligible.enqueueSource(source, "websub-push", false),
      ]);

      expect((await queue.getJob(jobId))?.data.skipCache).toBe(true);
      expect(await queue.getJobCountByTypes("waiting", "delayed")).toBe(1);
      expect(await enqueuer.takePendingRefresh(source.id)).toBeNull();
    });
  }

  test("a merge racing the worker's pop leaves the bypass on the marker", async () => {
    await queue.add(JobName.ParseSource, source, { jobId });

    const raceQueue = {
      add: queue.add.bind(queue),
      async getJob() {
        await connection.lmove(
          queue.toKey("wait"),
          queue.toKey("active"),
          "LEFT",
          "RIGHT",
        );
        return {
          async getState() {
            return "waiting";
          },
        };
      },
      toKey: queue.toKey,
    };
    const racer = new SourceEnqueuer(raceQueue, connection);

    await racer.enqueueSource(source, "manual", true);

    expect((await queue.getJob(jobId))?.data.skipCache).toBeUndefined();
    expect(await enqueuer.takePendingRefresh(source.id)).toEqual({
      skipCache: true,
    });
  });

  test("a paused queue behaves like a waiting merge", async () => {
    await queue.pause();
    try {
      await queue.add(JobName.ParseSource, source, { jobId });
      await enqueuer.enqueueSource(source);

      const job = await queue.getJob(jobId);
      expect(job?.data.skipCache).toBe(true);
      expect(await job?.getState()).toBe("waiting");
      expect(await enqueuer.takePendingRefresh(source.id)).toBeNull();
    } finally {
      await queue.resume();
    }
  });
});

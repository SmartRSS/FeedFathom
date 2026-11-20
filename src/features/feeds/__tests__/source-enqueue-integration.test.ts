import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { JobName } from "#features/feeds/queued-job.ts";
import { Job, Queue } from "bullmq";
import Redis from "ioredis";
import {
  type ParseRequest,
  parseSourceJobId,
  pendingParseRefreshKey,
  SourceEnqueuer,
} from "#features/feeds/source-enqueue.ts";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";

describe("queued refresh merging with BullMQ", () => {
  const connection = new Redis(requireDisposableRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(`source-enqueue-test-${crypto.randomUUID()}`, {
    connection,
  });
  const source = { id: 1 + Math.floor(Math.random() * 2_000_000_000) };
  const jobId = parseSourceJobId(source.id);
  const pendingKey = pendingParseRefreshKey(source.id);
  const enqueuer = new SourceEnqueuer(queue, connection);
  const followUp = async () => {
    const parsed: ParseRequest[] = [];
    await enqueuer.runParse(source, async (request) => {
      parsed.push(request);
    });
    return parsed[1] ?? null;
  };

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

  const merges: [boolean | undefined, boolean, string | null, boolean][] = [
    [undefined, false, null, false],
    [undefined, false, "0", false],
    [undefined, false, "1", true],
    [undefined, true, null, true],
    [undefined, true, "0", true],
    [undefined, true, "1", true],
    [false, false, null, false],
    [false, false, "0", false],
    [false, false, "1", true],
    [false, true, null, true],
    [false, true, "0", true],
    [false, true, "1", true],
    [true, false, null, true],
    [true, false, "0", true],
    [true, false, "1", true],
    [true, true, null, true],
    [true, true, "0", true],
    [true, true, "1", true],
  ];

  for (const delay of [0, 60_000]) {
    for (const [existing, incoming, pending, merged] of merges) {
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
        expect(job?.data.skipCache).toBe(merged);
        expect(await job?.getState()).toBe(delay ? "delayed" : "waiting");
        expect(await queue.getJobCountByTypes("waiting", "delayed")).toBe(1);
        expect(await followUp()).toBeNull();
      });
    }

    test(`stale handles cannot downgrade a concurrent bypass with delay=${delay}`, async () => {
      await queue.add(JobName.ParseSource, source, { delay, jobId });
      const stale = await Job.fromId(queue, jobId);
      if (!stale) throw new Error("Queued job was not found");
      const staleQueue = {
        add: queue.add.bind(queue),
        addBulk: queue.addBulk.bind(queue),
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
      expect(await followUp()).toBeNull();
    });
  }

  test("a merge racing the worker's pop leaves the bypass on the marker", async () => {
    await queue.add(JobName.ParseSource, source, { jobId });

    const raceQueue = {
      add: queue.add.bind(queue),
      addBulk: queue.addBulk.bind(queue),
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
    expect(await followUp()).toMatchObject({ skipCache: true });
  });

  test("a paused queue behaves like a waiting merge", async () => {
    await queue.pause();
    try {
      await queue.add(JobName.ParseSource, source, { jobId });
      await enqueuer.enqueueSource(source);

      const job = await queue.getJob(jobId);
      expect(job?.data.skipCache).toBe(true);
      expect(await job?.getState()).toBe("waiting");
      expect(await followUp()).toBeNull();
    } finally {
      await queue.resume();
    }
  });
});

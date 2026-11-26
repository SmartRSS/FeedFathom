import { expect, spyOn, test } from "bun:test";
import { loopbackWorkerJobs } from "#platform/__tests__/loopback-worker-requests.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import {
  createSourceJobHandlers,
  type SourceJobHandlerServices,
  SourceJobs,
} from "#features/feeds/source-jobs.ts";
import { pollFloorMs } from "#features/feeds/source-schedule-policy.ts";

type Enqueued = Parameters<
  SourceJobHandlerServices["sourceEnqueuer"]["enqueueSource"]
>;

const jobsFor = (services: Partial<SourceJobHandlerServices>) => {
  const sent: string[] = [];
  const handlers = new Map(
    createSourceJobHandlers({
      httpClient: strictFake<SourceJobHandlerServices["httpClient"]>(
        {},
        "httpClient",
      ),
      sourceEnqueuer: strictFake<SourceJobHandlerServices["sourceEnqueuer"]>(
        {},
        "sourceEnqueuer",
      ),
      ...services,
    }),
  );
  const jobs = new SourceJobs(
    loopbackWorkerJobs(
      () =>
        new Map(
          [...handlers].map(([name, handler]) => [
            name,
            async (data: unknown) => {
              sent.push(name);
              await handler(data);
            },
          ]),
        ),
    ),
  );
  return { handlers, jobs, sent };
};

const recordingEnqueuer = (enqueued: Enqueued[]) =>
  strictFake<SourceJobHandlerServices["sourceEnqueuer"]>({
    enqueueSource: async (...parameters) => {
      enqueued.push(parameters);
    },
  });

test("a batch of sources is one job, and the worker queues each with the refresh defaults", async () => {
  const enqueued: Enqueued[] = [];
  const { jobs, sent } = jobsFor({
    sourceEnqueuer: recordingEnqueuer(enqueued),
  });

  await jobs.refresh([3, 5, 8]);
  await jobs.refresh([]);

  expect(sent).toEqual(["REFRESH_SOURCES"]);
  expect(enqueued).toEqual([[{ id: 3 }], [{ id: 5 }], [{ id: 8 }]]);
});

test("WebSub discovery is queued by the worker", async () => {
  const discovered: number[] = [];
  const { jobs } = jobsFor({
    sourceEnqueuer: strictFake<SourceJobHandlerServices["sourceEnqueuer"]>({
      enqueueWebSubDiscovery: async (id) => {
        discovered.push(id);
      },
    }),
  });

  await jobs.discoverWebSub(91);

  expect(discovered).toEqual([91]);
});

test("a pushed body crosses as bytes, seeds the cache for the poll floor, and queues a cache-eligible parse", async () => {
  const enqueued: Enqueued[] = [];
  const seeded: [string, string, string | null, number][] = [];
  const body = Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x72, 0x73, 0x73, 0x00]);
  const { jobs } = jobsFor({
    httpClient: {
      seedCache: async (url, pushed, headers, freshForMs) => {
        seeded.push([
          url,
          pushed.toString("hex"),
          headers.get("content-type"),
          freshForMs,
        ]);
      },
    },
    sourceEnqueuer: recordingEnqueuer(enqueued),
  });

  await jobs.push(
    { id: 4, url: "https://feed.example/rss" },
    body,
    new Headers({ "content-type": "application/rss+xml" }),
  );

  expect(seeded).toEqual([
    [
      "https://feed.example/rss",
      body.toString("hex"),
      "application/rss+xml",
      pollFloorMs,
    ],
  ]);
  expect(enqueued).toEqual([[{ id: 4 }, "websub-push", false]]);
});

test("a thin ping, or a body the cache refused, queues a parse that bypasses the cache", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const enqueued: Enqueued[] = [];
  let seeds = 0;
  const { jobs } = jobsFor({
    httpClient: {
      seedCache: async () => {
        seeds++;
        throw new Error("redis is down");
      },
    },
    sourceEnqueuer: recordingEnqueuer(enqueued),
  });
  const source = { id: 4, url: "https://feed.example/rss" };

  try {
    await jobs.push(source, Buffer.alloc(0), new Headers());
    await jobs.push(source, Buffer.from("<rss/>"), new Headers());
  } finally {
    errors.mockRestore();
  }

  expect(seeds).toBe(1);
  expect(enqueued).toEqual([
    [{ id: 4 }, "websub-push", true],
    [{ id: 4 }, "websub-push", true],
  ]);
});

test("a job with an unexpected payload is refused before it reaches the enqueuer", async () => {
  const { handlers } = jobsFor({});

  for (const handler of handlers.values()) {
    // eslint-disable-next-line no-await-in-loop -- Each handler is checked alone.
    await expect(handler({ id: "1", ids: ["1"] })).rejects.toThrow(/^Invalid /);
  }
});

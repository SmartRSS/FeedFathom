import { expect, test } from "bun:test";
import type { OutboundFetchBudget } from "#features/feeds/outbound-fetch-budget.ts";
import type { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { postRefreshSourceHandler } from "#features/feeds/routes/refresh.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";

const servicesWith = (enqueued: { id: number; url: string }[]) => ({
  outboundFetchBudget: strictFake<OutboundFetchBudget>({
    consume: async () => {},
  }),
  sourceEnqueuer: strictFake<SourceEnqueuer>({
    enqueueSource: async (source) => {
      enqueued.push(source);
    },
  }),
  userSourcesDataService: strictFake<UserSourcesDataService>({
    getSubscribedSource: async (_userId, sourceId) =>
      sourceId === 7 ? { id: 7, url: "https://a.example/feed.xml" } : undefined,
  }),
});

test("queues a fetch of a source the user subscribes to", async () => {
  const enqueued: { id: number; url: string }[] = [];
  const response = await postRefreshSourceHandler(
    { body: { sourceId: 7 }, user: { id: 1 } },
    servicesWith(enqueued),
  );
  expect(response.status).toBe(200);
  expect(enqueued).toEqual([{ id: 7, url: "https://a.example/feed.xml" }]);
});

test("refuses a source the user does not subscribe to", async () => {
  const enqueued: { id: number; url: string }[] = [];
  const response = await postRefreshSourceHandler(
    { body: { sourceId: 8 }, user: { id: 1 } },
    servicesWith(enqueued),
  );
  expect(response.status).toBe(400);
  expect(enqueued).toEqual([]);
});

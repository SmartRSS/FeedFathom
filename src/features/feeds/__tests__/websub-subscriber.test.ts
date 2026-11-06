import { expect, spyOn, test } from "bun:test";
import type { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import { WebSubSubscriber } from "#features/feeds/websub-subscriber.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";

const lease = {
  callbackToken: "token",
  hubUrl: "https://hub.example/",
  id: 4,
  secret: "secret",
  topicUrl: "https://feed.example/feed.xml",
};

const subscriberWith = (hubStatus: number, domain?: string) => {
  const failed: number[] = [];
  const posted: string[] = [];
  const subscriber = new WebSubSubscriber(
    strictFake<WebSubStateService>({
      claimWebSubSubscribeAttempt: async () => true,
      getWebSubSubscriptionsNeedingRenewal: async () => [lease],
      markWebSubFailed: async (id) => {
        failed.push(id);
      },
      recordWebSubDiscovery: async () => lease,
    }),
    {
      post: async (url, body) => {
        posted.push(`${url} ${body.get("hub.callback")}`);
        return { status: hubStatus };
      },
    },
    domain,
  );
  return { failed, posted, subscriber };
};

test("a refused subscribe or renewal marks the subscription failed", async () => {
  using _ = spyOn(console, "error").mockImplementation(() => {});
  const { failed, posted, subscriber } = subscriberWith(500, "app.example");

  await subscriber.subscribe(lease.id, lease);
  await subscriber.renewDue();

  expect(posted).toEqual([
    "https://hub.example/ https://app.example/api/websub/callback/token",
    "https://hub.example/ https://app.example/api/websub/callback/token",
  ]);
  expect(failed).toEqual([lease.id, lease.id]);
});

test("an accepted request leaves the subscription to the hub's verification", async () => {
  const { failed, subscriber } = subscriberWith(202, "app.example");
  await subscriber.subscribe(lease.id, lease);
  await subscriber.renewDue();
  expect(failed).toEqual([]);
});

// Without a public domain no hub could reach the callback.
test("without a domain nothing is asked of any hub", async () => {
  const { posted, subscriber } = subscriberWith(202);
  expect(subscriber.wants("none")).toBe(false);
  await subscriber.subscribe(lease.id, lease);
  await subscriber.renewDue();
  expect(posted).toEqual([]);
});

import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import Redis from "ioredis";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";
import {
  type ArticleEvent,
  ArticleEventPublisher,
} from "#features/feeds/article-events.ts";
import { ArticleEventHub } from "#features/reader/article-event-hub.ts";

// The worker publishes through Bun's client and the server subscribes through
// ioredis, so the wire format is held between the two real clients here.
const redisUrl = requireDisposableRedisUrl();
const publisherRedis = new RedisClient(redisUrl);
const hub = new ArticleEventHub(() => new Redis(redisUrl));

afterAll(async () => {
  await hub.close();
  publisherRedis.close();
});

test("a published article event reaches every hub listener", async () => {
  const received: ArticleEvent[][] = [[], []];
  const closes: number[] = [];
  for (const [index, events] of received.entries())
    hub.listen({
      onClose: () => closes.push(index),
      onEvent: (event) => events.push(event),
    });
  const publisher = new ArticleEventPublisher(publisherRedis);

  // SUBSCRIBE is sent asynchronously; publish until the first one lands.
  for (let attempt = 0; received[1]!.length === 0 && attempt < 100; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Polls until delivery.
    await publisher.publish(7, 2);
    // eslint-disable-next-line no-await-in-loop -- Polls until delivery.
    await Bun.sleep(50);
  }
  expect(received[1]!.length).toBeGreaterThan(0);
  expect(received[1]).toEqual(received[0]);
  expect(received[0]![0]).toEqual({ count: 2, sourceId: 7 });

  await hub.close();
  expect(closes).toEqual([0, 1]);
});

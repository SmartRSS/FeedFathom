import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { HttpRateLimiter } from "#platform/http/http-rate-limiter.ts";
import { RequestDeadline } from "#platform/http/request-deadline.ts";
import { requireDisposableRedisUrl } from "../../../features/feeds/__tests__/disposable-redis-url.ts";

// The waiter scripts against a real server; http-rate-limiter.test.ts covers
// the same accounting through the fake that stands in for them.
const redis = new RedisClient(requireDisposableRedisUrl());

afterAll(() => {
  redis.close();
});

test("overlapping waiters keep a counter that covers their wait and leaves no key", async () => {
  const host = `${crypto.randomUUID()}.example.test`;
  const waitersKey = `http-interactive:${host}`;
  await redis.set(`http-interval:${host}`, "1", "PX", "10000");
  const deadlines = [new RequestDeadline(20_000), new RequestDeadline(20_000)];
  const reservations = deadlines.map(async (deadline) =>
    new HttpRateLimiter(redis).reserve(host, "interactive", deadline),
  );
  await Bun.sleep(100);

  expect(await redis.get(waitersKey)).toBe("2");
  expect(await redis.pttl(waitersKey)).toBeGreaterThan(9_000);

  await redis.del(`http-interval:${host}`);
  await Promise.race(reservations);
  await Bun.sleep(20);
  expect(await redis.get(waitersKey)).toBe("1");
  expect(await redis.pttl(waitersKey)).toBeGreaterThan(9_000);

  // The counter vanishing under the last waiter must not leave it at -1.
  await redis.del(waitersKey);
  await redis.del(`http-interval:${host}`);
  await Promise.all(reservations);
  await Bun.sleep(20);
  expect(await redis.exists(waitersKey)).toBe(false);
  for (const deadline of deadlines) deadline.dispose();
});

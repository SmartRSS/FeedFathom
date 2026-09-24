import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { HttpRateLimiter } from "#platform/http/http-rate-limiter.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { RequestDeadline } from "#platform/http/request-deadline.ts";
import { requireDisposableRedisUrl } from "../../../features/feeds/__tests__/disposable-redis-url.ts";

// The Lua scripts against a real server; http-rate-limiter.test.ts covers the
// same behaviour through the fake that stands in for them.
const redis = new RedisClient(requireDisposableRedisUrl());
const intervals = { background: 10_000, interactive: 500 };

afterAll(() => {
  redis.close();
});

async function reserve(
  host: string,
  priority: "background" | "interactive",
): Promise<number> {
  const deadline = new RequestDeadline(20_000);
  try {
    await new HttpRateLimiter(redis, intervals).reserve(
      host,
      priority,
      deadline,
    );
  } finally {
    deadline.dispose();
  }
  return Date.now();
}

test("the host clock spaces interactive requests and holds background back", async () => {
  const host = `${crypto.randomUUID()}.example.test`;
  const lastKey = `http-last-request:${host}`;

  const [first = 0, second = 0] = (
    await Promise.all([
      reserve(host, "interactive"),
      reserve(host, "interactive"),
    ])
  ).toSorted((left, right) => left - right);
  expect(second - first).toBeGreaterThanOrEqual(intervals.interactive - 10);
  expect(await redis.get(lastKey)).toMatch(/^\d{13}$/);
  expect(await redis.pttl(lastKey)).toBeGreaterThan(9_000);

  await expect(reserve(host, "background")).rejects.toBeInstanceOf(
    HttpDeferredError,
  );
});

test("overlapping waiters keep a counter that covers their wait and leaves no key", async () => {
  const host = `${crypto.randomUUID()}.example.test`;
  const waitersKey = `http-interactive:${host}`;
  await reserve(host, "interactive");
  const deadlines = [new RequestDeadline(20_000), new RequestDeadline(20_000)];
  const reservations = deadlines.map(async (deadline) =>
    new HttpRateLimiter(redis, intervals).reserve(
      host,
      "interactive",
      deadline,
    ),
  );
  await Bun.sleep(100);

  expect(await redis.get(waitersKey)).toBe("2");
  expect(await redis.pttl(waitersKey)).toBeGreaterThan(19_000);

  await Promise.race(reservations);
  await Bun.sleep(20);
  expect(await redis.get(waitersKey)).toBe("1");
  expect(await redis.pttl(waitersKey)).toBeGreaterThan(19_000);

  // The counter vanishing under the last waiter must not leave it at -1.
  await redis.del(waitersKey);
  await Promise.all(reservations);
  await Bun.sleep(20);
  expect(await redis.exists(waitersKey)).toBe(false);
  for (const deadline of deadlines) deadline.dispose();
});

import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { HttpRateLimiter } from "#platform/http/http-rate-limiter.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { RequestDeadline } from "#platform/http/request-deadline.ts";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";

const redis = new RedisClient(requireDisposableRedisUrl());
const intervals = { background: 10_000, interactive: 500 };

afterAll(() => {
  redis.close();
});

async function settlesTo(read: () => Promise<unknown>, expected: unknown) {
  for (let wait = 0; wait < 400; wait++) {
    // eslint-disable-next-line no-await-in-loop -- Polls until the write lands.
    if ((await read()) === expected) return;
    // eslint-disable-next-line no-await-in-loop -- Polls until the write lands.
    await Bun.sleep(5);
  }
  expect(await read()).toBe(expected);
}

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
  await settlesTo(() => redis.get(waitersKey), "2");
  expect(await redis.pttl(waitersKey)).toBeGreaterThan(19_000);

  await Promise.race(reservations);
  await settlesTo(() => redis.get(waitersKey), "1");
  expect(await redis.pttl(waitersKey)).toBeGreaterThan(19_000);

  await redis.del(waitersKey);
  await Promise.all(reservations);
  await settlesTo(() => redis.exists(waitersKey), false);
  for (const deadline of deadlines) deadline.dispose();
});

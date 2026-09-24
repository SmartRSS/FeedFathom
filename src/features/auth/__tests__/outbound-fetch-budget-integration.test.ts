import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { OutboundFetchBudget } from "#features/auth/outbound-fetch-budget.ts";
import { isHttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { requireDisposableRedisUrl } from "../../feeds/__tests__/disposable-redis-url.ts";

const redis = new RedisClient(requireDisposableRedisUrl());
const budget = new OutboundFetchBudget(redis);

afterAll(() => {
  redis.close();
});

// Each test gets its own user id so no counter outlives the test it came
// from into the next one.
function userId() {
  return Number(process.hrtime.bigint() % 1_000_000_000n);
}

test("every call a burst of concurrent requests makes carries the window", async () => {
  const user = userId();

  await Promise.all(Array.from({ length: 25 }, () => budget.consume(user)));

  expect(await redis.get(`outbound-fetch:${user}`)).toBe("25");
  const ttl = await redis.ttl(`outbound-fetch:${user}`);
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(60);
});

test("the 31st call is refused with a Retry-After of at most 60", async () => {
  const user = userId();

  for (let call = 0; call < 30; call++) {
    // eslint-disable-next-line no-await-in-loop -- Each call builds on the last.
    await budget.consume(user);
  }

  const error = await budget.consume(user).catch((caught: unknown) => caught);
  if (!isHttpDeferredError(error)) throw new Error("expected a deferral");
  const retryAfterSeconds = Math.ceil((error.retryAt - Date.now()) / 1000);
  expect(retryAfterSeconds).toBeGreaterThan(0);
  expect(retryAfterSeconds).toBeLessThanOrEqual(60);
});

test("a new window allows calls again", async () => {
  const user = userId();
  const key = `outbound-fetch:${user}`;
  for (let call = 0; call < 30; call++) {
    // eslint-disable-next-line no-await-in-loop -- Each call builds on the last.
    await budget.consume(user);
  }
  // Stands in for the window having passed.
  await redis.send("PEXPIRE", [key, "1"]);
  await Bun.sleep(50);

  await expect(budget.consume(user)).resolves.toBeUndefined();
});

test("two users' budgets are independent", async () => {
  const first = userId();
  const second = first + 1;

  for (let call = 0; call < 30; call++) {
    // eslint-disable-next-line no-await-in-loop -- Each call builds on the last.
    await budget.consume(first);
  }

  expect(
    isHttpDeferredError(await budget.consume(first).catch((e: unknown) => e)),
  ).toBe(true);
  await expect(budget.consume(second)).resolves.toBeUndefined();
});

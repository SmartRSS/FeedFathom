import { expect, test } from "bun:test";
import { OutboundFetchBudget } from "#features/auth/outbound-fetch-budget.ts";
import { isHttpDeferredError } from "#platform/http/http-deferred-error.ts";

// Enough of Redis for OutboundFetchBudget: one counter per key, with expiry
// applied against a clock the test advances. Runs the class's script by what
// it does (count, ttl-once-on-first-hit) rather than interpreting Lua.
function createFakeBudgetRedis() {
  let now = 0;
  const counts = new Map<string, { expiresAt: number; value: number }>();
  return {
    advance(seconds: number) {
      now += seconds;
    },
    async send(_command: "EVAL", args: string[]) {
      const key = args[2] ?? "";
      const window = Number(args[3] ?? "");
      const entry = counts.get(key);
      const live = entry && entry.expiresAt > now ? entry : undefined;
      const value = (live?.value ?? 0) + 1;
      const expiresAt = live?.expiresAt ?? now + window;
      counts.set(key, { expiresAt, value });
      return [value, expiresAt - now];
    },
  };
}

test("the 31st call inside a minute is refused, with Retry-After at most 60", async () => {
  const redis = createFakeBudgetRedis();
  const budget = new OutboundFetchBudget(redis);

  for (let call = 0; call < 30; call++) {
    // eslint-disable-next-line no-await-in-loop -- Each call builds on the last.
    await budget.consume(1);
  }

  const error = await budget.consume(1).catch((caught: unknown) => caught);
  if (!isHttpDeferredError(error)) throw new Error("expected a deferral");
  const retryAfterSeconds = Math.ceil((error.retryAt - Date.now()) / 1000);
  expect(retryAfterSeconds).toBeGreaterThan(0);
  expect(retryAfterSeconds).toBeLessThanOrEqual(60);
});

test("a new window allows calls again", async () => {
  const redis = createFakeBudgetRedis();
  const budget = new OutboundFetchBudget(redis);

  for (let call = 0; call < 30; call++) {
    // eslint-disable-next-line no-await-in-loop -- Each call builds on the last.
    await budget.consume(2);
  }
  expect(
    isHttpDeferredError(await budget.consume(2).catch((e: unknown) => e)),
  ).toBe(true);

  redis.advance(60);
  await expect(budget.consume(2)).resolves.toBeUndefined();
});

test("two users' budgets are independent", async () => {
  const redis = createFakeBudgetRedis();
  const budget = new OutboundFetchBudget(redis);

  for (let call = 0; call < 30; call++) {
    // eslint-disable-next-line no-await-in-loop -- Each call builds on the last.
    await budget.consume(1);
  }
  expect(
    isHttpDeferredError(await budget.consume(1).catch((e: unknown) => e)),
  ).toBe(true);
  await expect(budget.consume(2)).resolves.toBeUndefined();
});

test("a normal find-then-preview-then-subscribe flow stays under the limit", async () => {
  const redis = createFakeBudgetRedis();
  const budget = new OutboundFetchBudget(redis);

  // One find, three previewed candidates, one subscribe.
  for (let call = 0; call < 5; call++) {
    // eslint-disable-next-line no-await-in-loop -- Each call builds on the last.
    await budget.consume(3);
  }
  await expect(budget.consume(3)).resolves.toBeUndefined();
});

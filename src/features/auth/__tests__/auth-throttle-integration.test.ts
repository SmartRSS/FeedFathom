import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { AuthThrottle } from "#features/auth/auth-throttle.ts";
import { requireDisposableRedisUrl } from "../../../features/feeds/__tests__/disposable-redis-url.ts";

const redis = new RedisClient(requireDisposableRedisUrl());
const throttle = new AuthThrottle(redis);
const email = "victim@example.test";
const window = 15 * 60;

// Each test gets its own address so no counter outlives the test it came from
// into the next one.
function scopeKeys() {
  const address = `198.51.100.${crypto.randomUUID()}`;
  return {
    account: `login-fail:${address}:${email}`,
    address,
    source: `login-source:${address}`,
  };
}

afterAll(() => {
  redis.close();
});

test("every counter a burst of concurrent failures creates carries the window", async () => {
  const { account, address, source } = scopeKeys();

  await Promise.all(
    Array.from({ length: 25 }, () =>
      throttle.recordFailure("login", address, email),
    ),
  );

  expect(await redis.get(account)).toBe("25");
  expect(await redis.get(source)).toBe("25");
  for (const ttl of await Promise.all([
    redis.ttl(account),
    redis.ttl(source),
  ])) {
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(window);
  }
});

test("later failures keep the window the first one opened", async () => {
  const { account, address } = scopeKeys();
  await throttle.recordFailure("login", address, email);
  // Stands in for most of the window having passed.
  await redis.expire(account, 5);

  await Promise.all(
    Array.from({ length: 5 }, () =>
      throttle.recordFailure("login", address, email),
    ),
  );

  expect(await redis.get(account)).toBe("6");
  expect(await redis.ttl(account)).toBeLessThanOrEqual(5);
});

test("counters left without expiry recover a bounded lifetime", async () => {
  const { account, address, source } = scopeKeys();
  await redis.set(account, "10");
  await redis.set(source, "50");

  // A blocked request returns before counting, so the read repairs both.
  expect(await throttle.blocked("login", address, email)).toBe(true);
  expect(await redis.ttl(account)).toBe(window);
  expect(await redis.ttl(source)).toBe(window);

  // Counting repairs one that the read never saw at its limit.
  const other = scopeKeys();
  await redis.set(other.account, "3");
  await throttle.recordFailure("login", other.address, email);
  expect(await redis.get(other.account)).toBe("4");
  expect(await redis.ttl(other.account)).toBe(window);
});

test("reading creates no counter", async () => {
  const { account, address, source } = scopeKeys();

  expect(await throttle.blocked("login", address, email)).toBe(false);
  expect(await redis.exists(account)).toBe(false);
  expect(await redis.exists(source)).toBe(false);
});

test("counters stop blocking after the window and success clears only the account", async () => {
  const { account, address, source } = scopeKeys();
  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each failure builds on the last.
    await throttle.recordFailure("login", address, email);
  }
  expect(await throttle.blocked("login", address, email)).toBe(true);

  await throttle.clearFailures("login", address, email);
  expect(await redis.exists(account)).toBe(false);
  expect(await redis.get(source)).toBe("10");

  await redis.set(source, "50");
  await redis.send("PEXPIRE", [source, "50"]);
  expect(await throttle.blocked("login", address, email)).toBe(true);
  await Bun.sleep(100);
  expect(await throttle.blocked("login", address, email)).toBe(false);
});

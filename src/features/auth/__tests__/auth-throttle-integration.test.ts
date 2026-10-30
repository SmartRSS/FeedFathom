import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { AuthThrottle } from "#features/auth/auth-throttle.ts";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";

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

test("every counter a burst of concurrent attempts creates carries the window", async () => {
  const { account, address, source } = scopeKeys();

  const allowed = await Promise.all(
    Array.from({ length: 25 }, () => throttle.attempt("login", address, email)),
  );

  // Atomic INCR: exactly the limit get through, however many race.
  expect(allowed.filter(Boolean)).toHaveLength(10);
  expect(await redis.get(account)).toBe("25");
  // Only the attempts the account counter let through reach the address one.
  expect(await redis.get(source)).toBe("10");
  for (const ttl of await Promise.all([
    redis.ttl(account),
    redis.ttl(source),
  ])) {
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(window);
  }
});

test("later attempts keep the window the first one opened", async () => {
  const { account, address } = scopeKeys();
  await throttle.attempt("login", address, email);
  // Stands in for most of the window having passed.
  await redis.expire(account, 5);

  await Promise.all(
    Array.from({ length: 5 }, () => throttle.attempt("login", address, email)),
  );

  expect(await redis.get(account)).toBe("6");
  expect(await redis.ttl(account)).toBeLessThanOrEqual(5);
});

test("counters left without expiry recover a bounded lifetime", async () => {
  const { account, address, source } = scopeKeys();
  await redis.set(source, "50");

  // Over the address limit, so refused -- and repaired without being counted.
  expect(await throttle.attempt("login", address, email)).toBe(false);
  expect(await redis.get(source)).toBe("50");
  expect(await redis.ttl(source)).toBe(window);

  await redis.del(source);
  await redis.set(account, "3");
  await throttle.attempt("login", address, email);
  expect(await redis.get(account)).toBe("4");
  expect(await redis.ttl(account)).toBe(window);
});

test("an address at its limit is refused without creating an account key", async () => {
  const { address, source } = scopeKeys();
  await Promise.all(
    Array.from({ length: 50 }, (_, attempt) =>
      throttle.attempt("login", address, `user${attempt}@example.test`),
    ),
  );
  expect(await redis.get(source)).toBe("50");

  const fresh = `never-tried-${crypto.randomUUID()}@example.test`;
  expect(await throttle.attempt("login", address, fresh)).toBe(false);
  expect(await redis.exists(`login-fail:${address}:${fresh}`)).toBe(false);
  expect(await redis.get(source)).toBe("50");
});

test("the account counter does not grow while the address is locked", async () => {
  const { account, address, source } = scopeKeys();
  await throttle.attempt("login", address, email);
  await redis.set(source, "50", "KEEPTTL");

  for (let attempt = 0; attempt < 5; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each attempt builds on the last.
    expect(await throttle.attempt("login", address, email)).toBe(false);
  }
  expect(await redis.get(account)).toBe("1");
});

test("a success clears the account and refunds one attempt without creating a key", async () => {
  const { account, address, source } = scopeKeys();
  for (let attempt = 0; attempt < 3; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each attempt builds on the last.
    await throttle.attempt("login", address, email);
  }

  await throttle.succeeded("login", address, email);
  expect(await redis.exists(account)).toBe(false);
  expect(await redis.get(source)).toBe("2");
  expect(await redis.ttl(source)).toBeGreaterThan(0);

  // A refund after the window ran out must not leave a -1 with no expiry.
  await redis.del(source);
  await throttle.succeeded("login", address, email);
  expect(await redis.exists(source)).toBe(false);
});

test("a password change counts on the account counter alone", async () => {
  const address = `user:${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each attempt builds on the last.
    expect(await throttle.attempt("password-change", address, email)).toBe(
      true,
    );
  }
  expect(await throttle.attempt("password-change", address, email)).toBe(false);
  expect(await redis.exists(`password-change-source:${address}`)).toBe(false);

  await throttle.succeeded("password-change", address, email);
  expect(await redis.exists(`password-change-fail:${address}:${email}`)).toBe(
    false,
  );
});

test("counters stop refusing after the window", async () => {
  const { address, source } = scopeKeys();
  await redis.set(source, "50");
  await redis.send("PEXPIRE", [source, "50"]);
  expect(await throttle.attempt("login", address, email)).toBe(false);
  await Bun.sleep(100);
  expect(await throttle.attempt("login", address, email)).toBe(true);
});

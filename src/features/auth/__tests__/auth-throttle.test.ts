import { expect, test } from "bun:test";
import { AuthThrottle } from "#features/auth/auth-throttle.ts";
import { createFakeThrottleRedis } from "#features/auth/__tests__/fake-throttle-redis.ts";

const address = "203.0.113.7";

test("blocks an address grinding one account, and only that pair", async () => {
  const redis = createFakeThrottleRedis();
  const throttle = new AuthThrottle(redis);

  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each failure builds on the last.
    await throttle.recordFailure("login", address, "victim@example.test");
  }

  expect(await throttle.blocked("login", address, "victim@example.test")).toBe(
    true,
  );
  // A second account from the same address is untouched until the address
  // counter itself fills up, and another address never sees this at all.
  expect(await throttle.blocked("login", address, "other@example.test")).toBe(
    false,
  );
  expect(
    await throttle.blocked("login", "198.51.100.4", "victim@example.test"),
  ).toBe(false);
});

test("blocks an address spraying accounts before any one of them locks", async () => {
  const redis = createFakeThrottleRedis();
  const throttle = new AuthThrottle(redis);

  for (let attempt = 0; attempt < 50; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each failure builds on the last.
    await throttle.recordFailure(
      "login",
      address,
      `user${attempt}@example.test`,
    );
  }

  expect(await throttle.blocked("login", address, "user0@example.test")).toBe(
    true,
  );
  expect(
    await throttle.blocked("login", address, "never-tried@example.test"),
  ).toBe(true);
  expect(
    await throttle.blocked("login", "198.51.100.4", "user0@example.test"),
  ).toBe(false);
});

test("a success clears the account counter but not the address budget", async () => {
  const redis = createFakeThrottleRedis();
  const throttle = new AuthThrottle(redis);

  for (let attempt = 0; attempt < 49; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each failure builds on the last.
    await throttle.recordFailure(
      "login",
      address,
      `user${attempt}@example.test`,
    );
  }
  await throttle.clearFailures("login", address, "user0@example.test");

  // Clearing on success must not hand an attacker holding one valid account a
  // way to refill the budget they are spending against every other account.
  await throttle.recordFailure("login", address, "user0@example.test");
  expect(
    await throttle.blocked("login", address, "never-tried@example.test"),
  ).toBe(true);
});

test("the window is set once and not pushed back by later failures", async () => {
  const redis = createFakeThrottleRedis();
  const throttle = new AuthThrottle(redis);
  const key = `login-fail:${address}:victim@example.test`;

  await throttle.recordFailure("login", address, "victim@example.test");
  expect(redis.ttl(key)).toBe(15 * 60);

  redis.advance(60);
  await throttle.recordFailure("login", address, "victim@example.test");
  expect(redis.ttl(key)).toBe(14 * 60);
});

test("stops blocking once the window has passed", async () => {
  const redis = createFakeThrottleRedis();
  const throttle = new AuthThrottle(redis);

  for (let attempt = 0; attempt < 50; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each failure builds on the last.
    await throttle.recordFailure("login", address, "victim@example.test");
  }
  expect(await throttle.blocked("login", address, "victim@example.test")).toBe(
    true,
  );

  redis.advance(15 * 60);
  expect(await throttle.blocked("login", address, "victim@example.test")).toBe(
    false,
  );
});

test("a blocking counter left without expiry is given a window when read", async () => {
  const redis = createFakeThrottleRedis();
  const throttle = new AuthThrottle(redis);
  const account = `login-fail:${address}:victim@example.test`;
  const source = `login-source:${address}`;
  redis.setWithoutExpiry(account, 10);
  redis.setWithoutExpiry(source, 50);

  // A blocked request returns before counting, so the read has to repair it.
  expect(await throttle.blocked("login", address, "victim@example.test")).toBe(
    true,
  );
  expect(redis.ttl(account)).toBe(15 * 60);
  expect(redis.ttl(source)).toBe(15 * 60);
  // Reading an absent counter must not create one.
  expect(await throttle.blocked("login", address, "other@example.test")).toBe(
    true,
  );
  expect(redis.ttl(`login-fail:${address}:other@example.test`)).toBe(-2);

  redis.advance(15 * 60);
  expect(await throttle.blocked("login", address, "victim@example.test")).toBe(
    false,
  );
});

test("keeps each scope's budget to itself", async () => {
  const redis = createFakeThrottleRedis();
  const throttle = new AuthThrottle(redis);

  // Asking for a reset ten times -- because the first mail went to spam --
  // must not then refuse the login with the password that reset just set.
  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each failure builds on the last.
    await throttle.recordFailure(
      "password-reset",
      address,
      "victim@example.test",
    );
  }

  expect(
    await throttle.blocked("password-reset", address, "victim@example.test"),
  ).toBe(true);
  expect(await throttle.blocked("login", address, "victim@example.test")).toBe(
    false,
  );
});

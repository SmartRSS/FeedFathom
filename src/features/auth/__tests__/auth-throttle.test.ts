import { expect, test } from "bun:test";
import { AuthThrottle } from "#features/auth/auth-throttle.ts";
import { createFakeThrottleRedis } from "#features/auth/__tests__/fake-throttle-redis.ts";

const address = "203.0.113.7";

async function spend(
  throttle: AuthThrottle,
  times: number,
  email: (attempt: number) => string,
) {
  for (let attempt = 0; attempt < times; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each attempt builds on the last.
    await throttle.attempt("login", address, email(attempt));
  }
}

test("refuses an address grinding one account, and only that pair", async () => {
  const throttle = new AuthThrottle(createFakeThrottleRedis());

  await spend(throttle, 10, () => "victim@example.test");

  expect(await throttle.attempt("login", address, "victim@example.test")).toBe(
    false,
  );
  // A second account from the same address is untouched until the address
  // counter itself fills up, and another address never sees this at all.
  expect(await throttle.attempt("login", address, "other@example.test")).toBe(
    true,
  );
  expect(
    await throttle.attempt("login", "198.51.100.4", "victim@example.test"),
  ).toBe(true);
});

test("refuses an address spraying accounts before any one of them locks", async () => {
  const throttle = new AuthThrottle(createFakeThrottleRedis());

  await spend(throttle, 50, (attempt) => `user${attempt}@example.test`);

  expect(
    await throttle.attempt("login", address, "never-tried@example.test"),
  ).toBe(false);
  expect(
    await throttle.attempt("login", "198.51.100.4", "user0@example.test"),
  ).toBe(true);
});

// INCR gives each concurrent attempt its own number, so a burst cannot all
// pass a check that none of them has yet been counted against.
test("lets no more than the limit through a parallel burst", async () => {
  const throttle = new AuthThrottle(createFakeThrottleRedis());

  const results = await Promise.all(
    Array.from({ length: 200 }, () =>
      throttle.attempt("login", address, "victim@example.test"),
    ),
  );

  expect(results.filter(Boolean)).toHaveLength(10);
});

test("a success clears the account counter and refunds only its own attempt", async () => {
  const throttle = new AuthThrottle(createFakeThrottleRedis());

  await spend(throttle, 9, () => "user@example.test");
  // The right password on the tenth try: it counted, and takes itself back.
  expect(await throttle.attempt("login", address, "user@example.test")).toBe(
    true,
  );
  await throttle.succeeded("login", address, "user@example.test");
  await spend(throttle, 10, () => "user@example.test");
  expect(await throttle.attempt("login", address, "user@example.test")).toBe(
    false,
  );

  // Nineteen counted on the address -- the refused attempt never reached it
  // -- so 31 more fill it. A success refunds one, not the lot: one valid
  // account cannot refill the budget an attacker spends against every other.
  await spend(throttle, 31, (attempt) => `other${attempt}@example.test`);
  await throttle.succeeded("login", address, "user@example.test");
  expect(
    await throttle.attempt("login", address, "never-tried@example.test"),
  ).toBe(true);
  expect(
    await throttle.attempt("login", address, "never-tried-2@example.test"),
  ).toBe(false);
});

test("keeps each scope's budget to itself", async () => {
  const throttle = new AuthThrottle(createFakeThrottleRedis());

  // Asking for a reset ten times -- because the first mail went to spam --
  // must not then refuse the login with the password that reset just set.
  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each attempt builds on the last.
    await throttle.attempt("password-reset", address, "victim@example.test");
  }

  expect(
    await throttle.attempt("password-reset", address, "victim@example.test"),
  ).toBe(false);
  expect(await throttle.attempt("login", address, "victim@example.test")).toBe(
    true,
  );
});

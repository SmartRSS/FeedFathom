import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { createPooledDrizzleConnection } from "#platform/db/connection.ts";
import { UsersDataService } from "#features/auth/user-data-service.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "../../../features/feeds/__tests__/disposable-database-url.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

const databaseUrl = requireDisposableDatabaseUrl();
const client = new SQL(databaseUrl);
// A pool as wide as the race, so the registrations genuinely run on separate
// connections and meet at the table lock rather than queueing client-side.
const service = new UsersDataService(
  createPooledDrizzleConnection(databaseUrl, 8),
);

async function resetDatabase() {
  await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
  await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
  await client`CREATE SCHEMA "public"`;
  await migrateDatabase(databaseUrl, migrationsFolder);
}

const account = (index: number) => ({
  email: `reader${index}@example.test`,
  name: `reader${index}`,
  passwordHash: "hash",
});

test("disabled registration admits exactly one bootstrap account", async () => {
  await resetDatabase();

  const outcomes = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      service.createUser(account(index), false),
    ),
  );

  expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome === "closed")).toHaveLength(7);
  const rows = await client<{ is_admin: boolean }[]>`
    SELECT is_admin FROM users`;
  expect(rows).toEqual([{ is_admin: true }]);
});

test("enabled registration admits everyone and one administrator", async () => {
  await resetDatabase();

  const outcomes = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      service.createUser(account(index), true),
    ),
  );

  expect(outcomes.every((outcome) => outcome === "created")).toBe(true);
  const [counts] = await client<{ admins: number; total: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE is_admin)::int AS admins
    FROM users`;
  expect(counts).toEqual({ admins: 1, total: 8 });
});

test("withdrawing an activation token leaves a newer one alone", async () => {
  await resetDatabase();
  await service.createUser(
    {
      ...account(0),
      activationToken: "newer-token",
      activationTokenExpiresAt: new Date(Date.now() + 60_000),
      status: "inactive",
    },
    true,
  );

  await service.withdrawActivationToken("stale-token");
  expect(
    (
      await client<{ token: null | string }[]>`
      SELECT activation_token AS token FROM users`
    )[0]?.token,
  ).toBe("newer-token");

  await service.withdrawActivationToken("newer-token");
  expect(
    (
      await client<{ token: null | string }[]>`
      SELECT activation_token AS token FROM users`
    )[0]?.token,
  ).toBeNull();
});

// The route's lookup cannot see an account committed after it, so the insert
// itself must settle a same-address race: one row, the winner's credentials
// and token, and every loser told "exists" rather than failing on the unique
// index (#848). Run on an empty instance and on a populated one, since the
// two take different insert paths.
test.each([false, true])(
  "same-address registrations create one untouched account, populated=%s",
  async (populated) => {
    await resetDatabase();
    if (populated) await service.createUser(account(99), true);

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.createUser(
          {
            ...account(0),
            activationToken: `token-${index}`,
            activationTokenExpiresAt: new Date(Date.now() + 60_000),
            passwordHash: `hash-${index}`,
            status: "inactive",
          },
          true,
        ),
      ),
    );

    const winner = outcomes.indexOf("created");
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(outcomes.filter((outcome) => outcome === "exists")).toHaveLength(7);
    const rows = await client<{ password: string; token: string }[]>`
      SELECT password, activation_token AS token FROM users
      WHERE email = ${account(0).email}`;
    expect(rows).toEqual([
      { password: `hash-${winner}`, token: `token-${winner}` },
    ]);
  },
);

// A delivery that failed after the row committed withdraws the token, which
// leaves the account where the register route's expired-link recovery picks
// it up: still inactive, with no live link to wait out.
test("a withdrawn activation token leaves the account recoverable", async () => {
  await resetDatabase();
  await service.createUser(
    {
      ...account(0),
      activationToken: "undelivered-token",
      activationTokenExpiresAt: new Date(Date.now() + 60_000),
      status: "inactive",
    },
    true,
  );

  await service.withdrawActivationToken("undelivered-token");

  const user = await service.findUser(account(0).email);
  expect(user?.status).toBe("inactive");
  expect(user?.activationTokenExpiresAt).toBeNull();
});

async function pendingAccount(expiresAt: Date) {
  await resetDatabase();
  await service.createUser(
    {
      ...account(0),
      activationToken: "expired-token",
      activationTokenExpiresAt: expiresAt,
      status: "inactive",
    },
    true,
  );
  const user = await service.findUser(account(0).email);
  if (!user) throw new Error("pending account was not created");
  return user.id;
}

const storedToken = async () =>
  (await service.findUser(account(0).email))?.activationToken;

const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1_000);

// A replacement whose delivery failed is withdrawn, and the very next
// recovery stores and sends another rather than waiting out the day the
// undelivered one promised (#849).
test("a failed replacement delivery stays retryable", async () => {
  const userId = await pendingAccount(new Date(Date.now() - 60_000));

  expect(
    await service.refreshActivationToken(userId, "undelivered", tomorrow()),
  ).toBe(true);
  // A second recovery while that link is live stores nothing.
  expect(
    await service.refreshActivationToken(userId, "early", tomorrow()),
  ).toBe(false);
  await service.withdrawActivationToken("undelivered");

  expect(
    await service.refreshActivationToken(userId, "retry", tomorrow()),
  ).toBe(true);
  expect(await storedToken()).toBe("retry");
});

// Two recoveries racing on one expired link: one stores its token, and the
// loser's failure handling -- withdrawing a token that never took -- cannot
// clear the winner's delivered link.
test("concurrent recoveries keep the delivered link", async () => {
  const userId = await pendingAccount(new Date(Date.now() - 60_000));

  const [first, second] = await Promise.all([
    service.refreshActivationToken(userId, "first", tomorrow()),
    service.refreshActivationToken(userId, "second", tomorrow()),
  ]);
  expect([first, second].filter(Boolean)).toHaveLength(1);
  const winner = first ? "first" : "second";
  const loser = first ? "second" : "first";

  await service.withdrawActivationToken(loser);
  expect(await storedToken()).toBe(winner);
});

test("recovery leaves an active account untouched", async () => {
  const userId = await pendingAccount(new Date(Date.now() - 60_000));
  await service.activateUser(userId);

  expect(
    await service.refreshActivationToken(userId, "replacement", tomorrow()),
  ).toBe(false);
  const user = await service.findUser(account(0).email);
  expect(user?.status).toBe("active");
  expect(user?.activationToken).toBeNull();
});

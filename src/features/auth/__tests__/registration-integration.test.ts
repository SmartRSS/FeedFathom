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

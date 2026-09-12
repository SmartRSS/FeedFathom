import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { UsersDataService } from "#features/auth/user-data-service.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "../../../features/feeds/__tests__/disposable-database-url.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

const TOKEN_HASH = "token-hash";

async function setUp() {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const usersDataService = new UsersDataService(drizzleConnection);

  await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
  await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
  await client`CREATE SCHEMA "public"`;
  await migrateDatabase(databaseUrl, migrationsFolder);

  const [user] = await client<{ id: number }[]>`
    INSERT INTO users (email, name, password, status, password_reset_token_hash, password_reset_token_expires_at)
    VALUES ('reader@example.test', 'reader', 'old-password-hash', 'active', ${TOKEN_HASH}, NOW() + INTERVAL '1 hour')
    RETURNING id`;

  return { client, userId: user!.id, usersDataService };
}

// The spend rides in the UPDATE's WHERE clause, so "first writer wins" holds
// against the store itself, not just against a route handler's good manners:
// a second confirmation -- even one already past its token lookup -- matches
// no row and must leave the winner's password standing (#809).
test("only the first completion of a reset link spends it", async () => {
  const { client, userId, usersDataService } = await setUp();
  const sid = await usersDataService.createSession(userId, "This browser");

  expect(
    await usersDataService.completePasswordReset(
      userId,
      TOKEN_HASH,
      "new-password-hash",
    ),
  ).toBe(true);
  expect(await usersDataService.getUserBySid(sid)).toBeUndefined();

  const [row] = await client<{ password: string; token: null }[]>`
    SELECT password, password_reset_token_hash AS token FROM users WHERE id = ${userId}`;
  expect(row!.password).toBe("new-password-hash");
  expect(row!.token).toBeNull();

  // The link is gone now: a confirmation that was already past its lookup
  // -- or simply arrives late -- finds no row and changes nothing.
  expect(
    await usersDataService.completePasswordReset(
      userId,
      TOKEN_HASH,
      "attacker-password-hash",
    ),
  ).toBe(false);
  const [after] = await client<{ password: string }[]>`
    SELECT password FROM users WHERE id = ${userId}`;
  expect(after!.password).toBe("new-password-hash");
});

// Two confirmations submitted together, the issue's own repro: exactly one
// wins, and the surviving password is the winner's, never the later write.
test("simultaneous completions of one link let exactly one through", async () => {
  const { client, userId, usersDataService } = await setUp();
  const sid = await usersDataService.createSession(userId, "This browser");

  const [first, second] = await Promise.all([
    usersDataService.completePasswordReset(userId, TOKEN_HASH, "first-hash"),
    usersDataService.completePasswordReset(userId, TOKEN_HASH, "second-hash"),
  ]);
  expect([first, second].filter(Boolean)).toHaveLength(1);

  const [row] = await client<{ password: string; token: null }[]>`
    SELECT password, password_reset_token_hash AS token FROM users WHERE id = ${userId}`;
  expect(row!.password).toBe(first ? "first-hash" : "second-hash");
  expect(row!.token).toBeNull();
  expect(await usersDataService.getUserBySid(sid)).toBeUndefined();
});

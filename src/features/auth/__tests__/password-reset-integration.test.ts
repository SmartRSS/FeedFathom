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

// One pool for the whole file: every setUp re-migrates, and a pool per test
// adds connections that stay open until the process exits.
const databaseUrl = requireDisposableDatabaseUrl();
const client = new SQL(databaseUrl);
const usersDataService = new UsersDataService(
  createDrizzleConnection(databaseUrl),
);

async function setUp() {
  await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
  await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
  await client`CREATE SCHEMA "public"`;
  await migrateDatabase(databaseUrl, migrationsFolder);

  const [user] = await client<{ id: number }[]>`
    INSERT INTO users (email, name, password, status, password_reset_token_hash, password_reset_token_expires_at)
    VALUES ('reader@example.test', 'reader', 'old-password-hash', 'active', ${TOKEN_HASH}, NOW() + INTERVAL '1 hour')
    RETURNING id`;

  const userId = user!.id;
  const signIn = async (passwordHash = "old-password-hash") =>
    await usersDataService.createSession(userId, passwordHash, "This browser");
  return { client, signIn, userId, usersDataService };
}

// The spend rides in the UPDATE's WHERE clause, so "first writer wins" holds
// against the store itself, not just against a route handler's good manners:
// a second confirmation -- even one already past its token lookup -- matches
// no row and must leave the winner's password standing (#809).
test("only the first completion of a reset link spends it", async () => {
  const { client, signIn, userId, usersDataService } = await setUp();
  const sid = (await signIn()) ?? "";

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
  const { client, signIn, userId, usersDataService } = await setUp();
  const sid = (await signIn()) ?? "";

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

// A login verifies a hash it read before the reset and issues its session
// after: that session must not outlive the reset (#843). Issuance rechecks
// the hash under the row lock the reset's UPDATE takes, so a login that
// loses the race is refused and one that wins is revoked by the reset.
test("a login using the replaced password gets no session", async () => {
  const { client, signIn, userId, usersDataService } = await setUp();

  await usersDataService.completePasswordReset(
    userId,
    TOKEN_HASH,
    "new-password-hash",
  );

  expect(await signIn("old-password-hash")).toBeUndefined();
  const current = await signIn("new-password-hash");
  expect(current).toBeString();
  const rows = await client<{ sid: string }[]>`
    SELECT sid FROM sessions WHERE user_id = ${userId}`;
  expect(rows).toEqual([{ sid: current ?? "" }]);
});

test("no session from the old password survives a racing reset", async () => {
  const { client, signIn, userId, usersDataService } = await setUp();
  for (let round = 0; round < 20; round++) {
    // eslint-disable-next-line no-await-in-loop -- Each round is its own race.
    await client`
      UPDATE users SET password = 'old-password-hash',
        password_reset_token_hash = ${TOKEN_HASH},
        password_reset_token_expires_at = NOW() + INTERVAL '1 hour'
      WHERE id = ${userId}`;

    // eslint-disable-next-line no-await-in-loop -- Each round is its own race.
    await Promise.all([
      signIn("old-password-hash"),
      usersDataService.completePasswordReset(
        userId,
        TOKEN_HASH,
        "new-password-hash",
      ),
    ]);

    // eslint-disable-next-line no-await-in-loop -- Each round is its own race.
    const rows = await client`SELECT 1 FROM sessions WHERE user_id = ${userId}`;
    expect(rows).toHaveLength(0);
  }
});

import { expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { UsersDataService } from "#features/auth/user-data-service.ts";
import { digestToken } from "#features/auth/account-tokens.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

const TOKEN_HASH = "token-hash";

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
  return { signIn, userId };
}

test("only the first completion of a reset link spends it", async () => {
  const { signIn, userId } = await setUp();
  const sid = (await signIn()) ?? "";

  expect(
    await usersDataService.completePasswordReset(
      userId,
      TOKEN_HASH,
      "new-password-hash",
    ),
  ).toBe(true);
  expect(await usersDataService.authenticate(sid, null, false)).toBeUndefined();

  const [row] = await client<{ password: string; token: null }[]>`
    SELECT password, password_reset_token_hash AS token FROM users WHERE id = ${userId}`;
  expect(row!.password).toBe("new-password-hash");
  expect(row!.token).toBeNull();

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

test("simultaneous completions of one link let exactly one through", async () => {
  const { signIn, userId } = await setUp();
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
  expect(await usersDataService.authenticate(sid, null, false)).toBeUndefined();
});

test("a login using the replaced password gets no session", async () => {
  const { signIn, userId } = await setUp();

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
  expect([...rows]).toEqual([{ sid: current ?? "" }]);
});

test("no session from the old password survives a racing reset", async () => {
  const { signIn, userId } = await setUp();
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

test("a password change authorised by the replaced password writes nothing", async () => {
  const { userId } = await setUp();

  await usersDataService.completePasswordReset(
    userId,
    TOKEN_HASH,
    "reset-password-hash",
  );

  expect(
    await usersDataService.updatePassword(
      userId,
      "old-password-hash",
      "stale-change-hash",
      "current-sid",
    ),
  ).toBe(false);
  const [row] = await client<{ password: string }[]>`
    SELECT password FROM users WHERE id = ${userId}`;
  expect(row!.password).toBe("reset-password-hash");

  expect(
    await usersDataService.updatePassword(
      userId,
      "reset-password-hash",
      "changed-password-hash",
      "current-sid",
    ),
  ).toBe(true);
  const [after] = await client<{ password: string }[]>`
    SELECT password FROM users WHERE id = ${userId}`;
  expect(after!.password).toBe("changed-password-hash");
});

test("a password change signs out every other session and keeps the current one", async () => {
  const { signIn, userId } = await setUp();
  const current = (await signIn()) ?? "";
  const other = (await signIn()) ?? "";

  expect(
    await usersDataService.updatePassword(
      userId,
      "old-password-hash",
      "changed-password-hash",
      current,
    ),
  ).toBe(true);

  expect((await usersDataService.authenticate(current, null, false))?.id).toBe(
    userId,
  );
  expect(
    await usersDataService.authenticate(other, null, false),
  ).toBeUndefined();
  expect(await signIn()).toBeUndefined();
});

test("a reset token is stored as a digest and found only while it is live", async () => {
  const { userId } = await setUp();

  const token = await usersDataService.startPasswordReset(userId);
  const [row] = await client<{ hash: string }[]>`
    SELECT password_reset_token_hash AS hash FROM users WHERE id = ${userId}`;
  expect(row?.hash).toBe(digestToken(token));
  expect(row?.hash).not.toBe(token);
  expect(
    (await usersDataService.findUserByPasswordResetToken(digestToken(token)))
      ?.id,
  ).toBe(userId);

  await client`UPDATE users SET password_reset_token_expires_at = NOW() - INTERVAL '1 second'`;
  expect(
    await usersDataService.findUserByPasswordResetToken(digestToken(token)),
  ).toBeUndefined();
});

test("a session opened without a User-Agent lists none", async () => {
  const { userId } = await setUp();
  const sid =
    (await usersDataService.createSession(userId, "old-password-hash", null)) ??
    "";
  const [session] = await usersDataService.listSessions(userId, sid);
  expect(session?.userAgent).toBeNull();
});

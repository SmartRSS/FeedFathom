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

// A session that no longer resolves is the whole expiry feature: the lookup
// is the choke point every request's auth flows through, so these tests pin
// what it accepts, and that revocation is scoped to the caller's own rows.
test("expired sessions stop resolving and revocation stays scoped", async () => {
  const databaseUrl = requireDisposableDatabaseUrl();
  const client = new SQL(databaseUrl);
  const drizzleConnection = createDrizzleConnection(databaseUrl);
  const usersDataService = new UsersDataService(drizzleConnection);

  try {
    await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
    await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
    await client`CREATE SCHEMA "public"`;
    await migrateDatabase(databaseUrl, migrationsFolder);

    const [user] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('reader@example.test', 'reader', 'x') RETURNING id`;
    const [other] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('other@example.test', 'other', 'x') RETURNING id`;
    const userId = user!.id;
    const otherId = other!.id;

    const browserSid = await usersDataService.createSession(
      userId,
      "This browser",
    );
    const phoneSid = await usersDataService.createSession(userId, "Phone");
    const tabletSid = await usersDataService.createSession(userId, "Tablet");
    const stolenSid = await usersDataService.createSession(otherId, "Stolen");

    // A fresh session resolves, and carries the same window the cookie
    // promises -- roughly a year, not forever and not zero.
    const fresh = await usersDataService.getUserBySid(browserSid);
    expect(fresh?.id).toBe(userId);
    const [window] = await client<{ delta: number }[]>`
      SELECT CAST(EXTRACT(EPOCH FROM (expires_at - created_at)) / 86400 AS int)
             AS delta
      FROM sessions WHERE sid = ${browserSid}`;
    expect(window!.delta).toBe(365);

    // Expiry is enforced in the lookup itself: an aged-out sid resolves to
    // no user, which the auth plugin answers with a 401.
    await client`
      UPDATE sessions SET expires_at = NOW() - INTERVAL '1 day'
      WHERE sid = ${phoneSid}`;
    expect(await usersDataService.getUserBySid(phoneSid)).toBeUndefined();
    expect((await usersDataService.getUserBySid(browserSid))?.id).toBe(userId);

    // The list the options page renders enforces the same expiry as the
    // lookup: the aged-out session is not listed as active -- not even as
    // the requesting one -- while the live rows stay, newest first, with
    // the requesting session flagged.
    expect(
      (await usersDataService.listSessions(userId, phoneSid)).map(
        (session) => session.userAgent,
      ),
    ).toEqual(["Tablet", "This browser"]);
    const listed = await usersDataService.listSessions(userId, tabletSid);
    expect(
      listed.map((session) => ({
        sid: session.current,
        ua: session.userAgent,
      })),
    ).toEqual([
      { sid: true, ua: "Tablet" },
      { sid: false, ua: "This browser" },
    ]);

    // A session id from another account is out of reach.
    const [stolenRow] = await client<{ id: number }[]>`
      SELECT id FROM sessions WHERE sid = ${stolenSid}`;
    await usersDataService.deleteSessionById(userId, stolenRow!.id);
    expect((await usersDataService.getUserBySid(stolenSid))?.id).toBe(otherId);

    // Revoking everything else leaves the current session standing.
    await usersDataService.deleteOtherSessions(userId, browserSid);
    expect((await usersDataService.getUserBySid(browserSid))?.id).toBe(userId);
    expect(
      await usersDataService.listSessions(userId, browserSid),
    ).toHaveLength(1);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

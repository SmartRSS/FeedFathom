import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import {
  authenticateStatement,
  UsersDataService,
} from "#features/auth/user-data-service.ts";
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
      INSERT INTO users (email, name, password, status)
      VALUES ('reader@example.test', 'reader', 'x', 'active') RETURNING id`;
    const [other] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('other@example.test', 'other', 'x') RETURNING id`;
    const userId = user!.id;
    const otherId = other!.id;

    const issue = async (id: number, userAgent: string) => {
      const sid = await usersDataService.createSession(id, "x", userAgent);
      if (!sid) throw new Error("session was not issued");
      return sid;
    };
    const browserSid = await issue(userId, "This browser");
    const phoneSid = await issue(userId, "Phone");
    const tabletSid = await issue(userId, "Tablet");
    const stolenSid = await issue(otherId, "Stolen");

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
    // the requesting one -- while the live rows stay, most recently active
    // first, with the requesting session flagged.
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

    // Activity, not creation, orders the list: the created_at migration
    // backfilled pre-existing rows with one shared timestamp, so rows the
    // list must still distinguish are separated by their last_used_at.
    await client`
      UPDATE sessions SET last_used_at = NOW() - INTERVAL '2 days'
      WHERE sid = ${tabletSid}`;
    expect(
      (await usersDataService.listSessions(userId, tabletSid)).map(
        (session) => session.userAgent,
      ),
    ).toEqual(["This browser", "Tablet"]);

    // Each answered request refreshes the row's activity stamp and its
    // User-Agent, so the device label follows the browser across updates.
    await usersDataService.authenticate(browserSid, "This browser 2.0");
    const [refreshed] = await client<
      {
        last_used_at: Date;
        user_agent: string;
      }[]
    >`
      SELECT last_used_at, user_agent FROM sessions WHERE sid = ${browserSid}`;
    expect(refreshed!.user_agent).toBe("This browser 2.0");
    expect(refreshed!.last_used_at.getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );

    // A missing header never overwrites a known agent with the UNKNOWN
    // sentinel, and a stale row within its freshness window is left alone.
    await usersDataService.authenticate(browserSid, null);
    expect(
      (
        await client<{ user_agent: string }[]>`
          SELECT user_agent FROM sessions WHERE sid = ${browserSid}`
      )[0]!.user_agent,
    ).toBe("This browser 2.0");

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

type Versions = { session: string; user: string };

// The auth plugin's one statement writes only when a guard fires. A row's
// xmin names the transaction that last wrote it, so an unchanged xmin proves
// no write happened -- for an unknown, expired or inactive sid, and for a
// second request inside both guard windows.
test("authenticate stamps an active session at most once per guard window", async () => {
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
      INSERT INTO users (email, name, password, status, last_seen_at)
      VALUES ('stamped@example.test', 'stamped', 'x', 'active',
        NOW() - INTERVAL '2 days')
      RETURNING id`;
    const userId = user!.id;
    const sid = await usersDataService.createSession(userId, "x", "Browser");
    if (!sid) throw new Error("session was not issued");
    await client`
      UPDATE sessions SET last_used_at = NOW() - INTERVAL '2 minutes'
      WHERE sid = ${sid}`;

    const versions = async () => {
      const [row] = await client<Versions[]>`
        SELECT sessions.xmin::text AS session, users.xmin::text AS user
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.sid = ${sid}`;
      if (!row) throw new Error("session row is missing");
      return row;
    };
    const expectNoWrite = async (resolveSid: string) => {
      const before = await versions();
      expect(
        await usersDataService.authenticate(resolveSid, "Browser"),
      ).toBeUndefined();
      expect(await versions()).toEqual(before);
    };

    await expectNoWrite("no-such-sid");
    await client`UPDATE users SET status = 'inactive' WHERE id = ${userId}`;
    await expectNoWrite(sid);
    await client`UPDATE users SET status = 'active' WHERE id = ${userId}`;
    await client`
      UPDATE sessions SET expires_at = NOW() - INTERVAL '1 second'
      WHERE sid = ${sid}`;
    await expectNoWrite(sid);
    await client`
      UPDATE sessions SET expires_at = NOW() + INTERVAL '1 day'
      WHERE sid = ${sid}`;

    // Past both windows, one request stamps both rows; the next writes
    // nothing.
    const stale = await versions();
    expect(await usersDataService.authenticate(sid, "Browser")).toEqual({
      email: "stamped@example.test",
      id: userId,
      isAdmin: false,
      name: "stamped",
      status: "active",
    });
    const stamped = await versions();
    expect(stamped.session).not.toBe(stale.session);
    expect(stamped.user).not.toBe(stale.user);
    expect((await usersDataService.authenticate(sid, "Browser"))?.id).toBe(
      userId,
    );
    expect(await versions()).toEqual(stamped);

    // A changed User-Agent is the one reason to write the session row inside
    // its minute; the user row keeps its daily window.
    await usersDataService.authenticate(sid, "Browser 2");
    const relabelled = await versions();
    expect(relabelled.session).not.toBe(stamped.session);
    expect(relabelled.user).toBe(stamped.user);

    // Both sid probes in the statement use the unique index. Sequential scans
    // are priced out so a one-row table cannot make one look cheaper; without
    // the index the planner has no alternative and would still show one.
    // EXPLAIN without ANALYZE plans the data-modifying CTEs but runs nothing.
    const plan = await drizzleConnection.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows: unknown = await transaction.execute(
        sql`EXPLAIN ${authenticateStatement(sid, "Browser")}`,
      );
      return JSON.stringify(rows);
    });
    expect(plan.match(/Index Scan using sessions_sid_unique/gu)).toHaveLength(
      2,
    );
    expect(plan).not.toContain("Seq Scan");
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

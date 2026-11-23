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
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);

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
      INSERT INTO users (email, name, password, status)
      VALUES ('other@example.test', 'other', 'x', 'active') RETURNING id`;
    const [dormant] = await client<{ id: number }[]>`
      INSERT INTO users (email, name, password)
      VALUES ('dormant@example.test', 'dormant', 'x') RETURNING id`;
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

    const fresh = await usersDataService.authenticate(browserSid, null, false);
    expect(fresh?.id).toBe(userId);
    const [window] = await client<{ delta: number }[]>`
      SELECT CAST(EXTRACT(EPOCH FROM (expires_at - created_at)) / 86400 AS int)
             AS delta
      FROM sessions WHERE sid = ${browserSid}`;
    expect(window!.delta).toBe(365);

    const dormantSid = await issue(dormant!.id, "Dormant");
    expect(
      await usersDataService.authenticate(dormantSid, null, false),
    ).toBeUndefined();
    expect(
      await usersDataService.authenticate(dormantSid, "Dormant"),
    ).toBeUndefined();

    await client`
      UPDATE sessions SET expires_at = NOW() - INTERVAL '1 day'
      WHERE sid = ${phoneSid}`;
    expect(
      await usersDataService.authenticate(phoneSid, null, false),
    ).toBeUndefined();
    expect(
      (await usersDataService.authenticate(browserSid, null, false))?.id,
    ).toBe(userId);

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

    await client`
      UPDATE sessions SET last_used_at = NOW() - INTERVAL '2 days'
      WHERE sid = ${tabletSid}`;
    expect(
      (await usersDataService.listSessions(userId, tabletSid)).map(
        (session) => session.userAgent,
      ),
    ).toEqual(["This browser", "Tablet"]);

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

    await usersDataService.authenticate(browserSid, null);
    expect(
      (
        await client<{ user_agent: string }[]>`
          SELECT user_agent FROM sessions WHERE sid = ${browserSid}`
      )[0]!.user_agent,
    ).toBe("This browser 2.0");

    const [stolenRow] = await client<{ id: number }[]>`
      SELECT id FROM sessions WHERE sid = ${stolenSid}`;
    await usersDataService.deleteSessionById(userId, stolenRow!.id);
    expect(
      (await usersDataService.authenticate(stolenSid, null, false))?.id,
    ).toBe(otherId);

    await usersDataService.deleteOtherSessions(userId, browserSid);
    expect(
      (await usersDataService.authenticate(browserSid, null, false))?.id,
    ).toBe(userId);
    expect(
      await usersDataService.listSessions(userId, browserSid),
    ).toHaveLength(1);
  } finally {
    await drizzleConnection.$client.close();
    await client.close();
  }
});

type Versions = { session: string; user: string };

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

    const stale = await versions();
    expect((await usersDataService.authenticate(sid, null, false))?.id).toBe(
      userId,
    );
    expect(await versions()).toEqual(stale);

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

    await usersDataService.authenticate(sid, "Browser 2");
    const relabelled = await versions();
    expect(relabelled.session).not.toBe(stamped.session);
    expect(relabelled.user).toBe(stamped.user);

    const plan = await drizzleConnection.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows: unknown = await transaction.execute(
        sql`EXPLAIN ${authenticateStatement(transaction, sid, "Browser").getSQL()}`,
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

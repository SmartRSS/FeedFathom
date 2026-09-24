import crypto from "node:crypto";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { and, desc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { sessions } from "#platform/db/schemas/sessions.ts";
import { users } from "#platform/db/schemas/users.ts";

const authenticatedRowsCheck = Schema.Compile(
  Type.Array(
    Type.Object(
      {
        email: Type.String(),
        id: Type.Integer(),
        isAdmin: Type.Boolean(),
        name: Type.String(),
        status: Type.Literal("active"),
      },
      { additionalProperties: false },
    ),
  ),
);

// Exported so an integration test can EXPLAIN the statement the auth plugin
// actually runs rather than a copy of it.
export function authenticateStatement(sid: string, userAgent: null | string) {
  return sql`
    WITH "resolved" AS (
      SELECT "users"."id", "users"."email", "users"."name",
             "users"."is_admin", "users"."status"
      FROM "sessions"
      INNER JOIN "users" ON "users"."id" = "sessions"."user_id"
      WHERE "sessions"."sid" = ${sid}
        AND "sessions"."expires_at" > NOW()
        AND "users"."status" = 'active'
    ),
    "touch_session" AS (
      UPDATE "sessions"
      SET "last_used_at" = NOW(),
          "user_agent" = COALESCE(${userAgent}, "user_agent")
      WHERE "sid" = ${sid}
        AND EXISTS (SELECT 1 FROM "resolved")
        AND (
          "last_used_at" < NOW() - INTERVAL '1 minute'
          OR "user_agent" IS DISTINCT FROM COALESCE(${userAgent}, "user_agent")
        )
    ),
    "touch_user" AS (
      UPDATE "users"
      SET "last_seen_at" = NOW()
      WHERE "id" = (SELECT "id" FROM "resolved")
        AND "last_seen_at" < NOW() - INTERVAL '1 day'
    )
    SELECT "id", "email", "name", "is_admin" AS "isAdmin", "status"
    FROM "resolved"
  `;
}

export class UsersDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

  // Annotated rather than inferred: crypto.randomUUID() infers the
  // `${string}-${string}-...` template literal type, which promises callers
  // and test doubles a UUID shape nothing depends on.
  //
  // passwordHash is the stored hash the caller verified. The session is only
  // issued while the row still holds it, checked under the row lock that
  // completePasswordReset's UPDATE also takes: a login that locks first has
  // its session deleted by the reset, and one that locks after the reset sees
  // the new hash and gets undefined -- no session from a revoked password.
  public async createSession(
    userId: number,
    passwordHash: string,
    userAgent?: null | string,
  ): Promise<string | undefined> {
    const uuid = crypto.randomUUID();
    return await this.drizzleConnection.transaction(async (transaction) => {
      const current = await transaction
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.password, passwordHash)))
        .for("update");
      if (!current.length) return undefined;
      await transaction.insert(sessions).values({
        sid: uuid,
        userAgent: userAgent ?? "UNKNOWN",
        userId,
      });
      return uuid;
    });
  }

  public async deleteSession(sid: string) {
    await this.drizzleConnection.delete(sessions).where(eq(sessions.sid, sid));
  }

  /**
   * "closed" means the registration policy refused the account. The policy is
   * rechecked here rather than trusted from the route's earlier count: two
   * registrations on an empty instance with registration disabled both pass
   * that count, and only the bootstrap lock below can admit exactly one.
   * "exists" means the address was taken, possibly by a registration that
   * committed after the route's lookup; the existing row is left untouched.
   */
  public async createUser(
    payload: {
      email: string;
      name: string;
      passwordHash: string;
      status?: "active" | "inactive";
      activationToken?: string;
      activationTokenExpiresAt?: Date;
    },
    registrationEnabled: boolean,
  ): Promise<"closed" | "created" | "exists"> {
    const values = (isAdmin: boolean) => ({
      activationToken: payload.activationToken,
      activationTokenExpiresAt: payload.activationTokenExpiresAt,
      email: payload.email,
      isAdmin,
      name: payload.name,
      password: payload.passwordHash,
      status: payload.status,
    });

    // The table-lock below only exists to resolve the "first user becomes
    // admin" race under concurrent registrations -- once any user exists,
    // there's no bootstrap race left to resolve, so skip straight to a
    // plain insert instead of serializing every registration behind a
    // whole-table lock.
    const usersExist = (
      await this.drizzleConnection.select({ id: users.id }).from(users).limit(1)
    ).at(0);
    if (usersExist) {
      if (!registrationEnabled) return "closed";
      const inserted = await this.drizzleConnection
        .insert(users)
        .values(values(false))
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      return inserted.length ? "created" : "exists";
    }

    return await this.drizzleConnection.transaction(async (transaction) => {
      await transaction.execute(
        sql`lock table ${users} in share row exclusive mode`,
      );
      const existingUser = (
        await transaction.select({ id: users.id }).from(users).limit(1)
      ).at(0);
      if (existingUser && !registrationEnabled) return "closed";

      const inserted = await transaction
        .insert(users)
        .values(values(!existingUser))
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      return inserted.length ? "created" : "exists";
    });
  }

  public async findUser(email: string) {
    return (
      await this.drizzleConnection
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
    ).at(0);
  }

  public async findUserByActivationToken(token: string) {
    return (
      await this.drizzleConnection
        .select()
        .from(users)
        .where(eq(users.activationToken, token))
        .limit(1)
    ).at(0);
  }

  // A pending registration whose link expired, or was withdrawn after a failed
  // delivery, gets the same address back on the fresh token; the status
  // predicate keeps an already-active account's row untouched -- that path
  // belongs to the password reset, not to a re-registration (#810). The
  // expiry predicate makes this a compare-and-set: of two concurrent
  // recoveries only one stores a token, so the other cannot overwrite a link
  // that was just mailed. False means nothing was stored and nothing to send.
  public async refreshActivationToken(
    userId: number,
    token: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const refreshed = await this.drizzleConnection
      .update(users)
      .set({ activationToken: token, activationTokenExpiresAt: expiresAt })
      .where(
        and(
          eq(users.id, userId),
          eq(users.status, "inactive"),
          or(
            isNull(users.activationTokenExpiresAt),
            lt(users.activationTokenExpiresAt, sql`now()`),
          ),
        ),
      )
      .returning({ id: users.id });
    return refreshed.length > 0;
  }

  // Compare-and-set on the token: a link whose mail never left is withdrawn so
  // the next registration attempt sends a fresh one, while a newer token some
  // other request already stored and delivered is left alone.
  public async withdrawActivationToken(token: string) {
    await this.drizzleConnection
      .update(users)
      .set({ activationToken: null, activationTokenExpiresAt: null })
      .where(
        and(eq(users.activationToken, token), eq(users.status, "inactive")),
      );
  }

  public async activateUser(userId: number) {
    return await this.drizzleConnection
      .update(users)
      .set({
        activationToken: null,
        activationTokenExpiresAt: null,
        status: "active",
      })
      .where(eq(users.id, userId))
      .execute();
  }

  // The expiry predicate lives here rather than in a caller-side check, so
  // an expired sid resolves to no user at all. authenticate applies the same
  // predicate for the routes behind the auth plugin; this read-only lookup
  // serves GET /api/session, which must not count as activity.
  public async getUserBySid(sid: string) {
    return (
      await this.drizzleConnection
        .select({
          email: users.email,
          id: users.id,
          isAdmin: users.isAdmin,
          name: users.name,
          status: users.status,
        })
        .from(users)
        .where(and(eq(sessions.sid, sid), gt(sessions.expiresAt, sql`NOW()`)))
        .leftJoin(sessions, eq(sessions.userId, users.id))
        .limit(1)
    ).at(0);
  }

  /**
   * The auth plugin's whole round-trip: resolves the sid the way getUserBySid
   * does, and stamps activity in the same statement. PostgreSQL runs a
   * data-modifying CTE even when the final SELECT never reads it, so both
   * writes happen without a second round-trip.
   *
   * Each write guards itself, so most requests write nothing: the session row
   * only when it is more than a minute stale or the User-Agent changed, the
   * user row once a day. COALESCE keeps a missing header from overwriting a
   * known agent with the UNKNOWN sentinel. An unknown, expired or inactive
   * sid resolves to no user and writes nothing.
   */
  public async authenticate(sid: string, userAgent: null | string) {
    const rows: unknown = await this.drizzleConnection.execute(
      authenticateStatement(sid, userAgent),
    );
    if (!authenticatedRowsCheck.Check(rows)) {
      throw new Error("Database returned an invalid authenticated user row");
    }
    return rows.at(0);
  }

  // One row per active session of the user's, most recently active first,
  // with the requesting session flagged so the options page can label it
  // and keep the revoke buttons off it. The same expiry predicate
  // getUserBySid enforces applies here: a session that no longer resolves
  // must not be listed as active -- the retention pass only prunes the
  // dead rows on its own schedule, not before every listing. Ordered by
  // activity rather than creation because the migration that introduced
  // created_at backfilled every pre-existing row with one shared
  // ALTER-time timestamp, making creation order unrecoverable there.
  public async listSessions(userId: number, currentSid: string) {
    return await this.drizzleConnection
      .select({
        createdAt: sessions.createdAt,
        current: sql<boolean>`${sessions.sid} = ${currentSid}`,
        expiresAt: sessions.expiresAt,
        id: sessions.id,
        lastUsedAt: sessions.lastUsedAt,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(
        and(eq(sessions.userId, userId), gt(sessions.expiresAt, sql`NOW()`)),
      )
      .orderBy(desc(sessions.lastUsedAt), desc(sessions.id));
  }

  // Both revocation paths scope by userId so a guessed or forged id can
  // only ever land on the caller's own rows.
  public async deleteSessionById(userId: number, sessionId: number) {
    await this.drizzleConnection
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)));
  }

  public async deleteOtherSessions(userId: number, currentSid: string) {
    await this.drizzleConnection
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.sid, currentSid)));
  }

  public async getUserCount(): Promise<number> {
    const result = await this.drizzleConnection
      .select({
        count: sql`count(${users.id})`,
      })
      .from(users);

    return Number(result[0]?.count ?? 0);
  }

  public async startPasswordReset(
    userId: number,
    tokenHash: string,
    expiresAt: Date,
  ) {
    await this.drizzleConnection
      .update(users)
      .set({
        passwordResetTokenExpiresAt: expiresAt,
        passwordResetTokenHash: tokenHash,
      })
      .where(eq(users.id, userId));
  }

  public async findUserByPasswordResetToken(tokenHash: string) {
    return (
      await this.drizzleConnection
        .select()
        .from(users)
        .where(eq(users.passwordResetTokenHash, tokenHash))
        .limit(1)
    ).at(0);
  }

  /**
   * The new password, the spent token and every session, in one transaction.
   * Split across three statements a crash between them leaves either a token
   * that still works against the new password or sessions the old one opened.
   * The token hash rides in the UPDATE's WHERE clause rather than only in the
   * lookup before it: two confirmations racing on the same link then cannot
   * both write -- the row lock serialises them and the second re-check
   * matches nothing -- so the first commit wins and the caller of the loser
   * is told the link is no longer valid (#809). False means that loser.
   */
  public async completePasswordReset(
    userId: number,
    tokenHash: string,
    passwordHash: string,
  ): Promise<boolean> {
    return await this.drizzleConnection.transaction(async (transaction) => {
      const spent = await transaction
        .update(users)
        .set({
          password: passwordHash,
          passwordResetTokenExpiresAt: null,
          passwordResetTokenHash: null,
        })
        .where(
          and(
            eq(users.id, userId),
            eq(users.passwordResetTokenHash, tokenHash),
          ),
        )
        .returning({ id: users.id });
      if (!spent.length) return false;
      await transaction.delete(sessions).where(eq(sessions.userId, userId));
      return true;
    });
  }

  public async updatePassword(userId: number, passwordHash: string) {
    return await this.drizzleConnection
      .update(users)
      .set({ password: passwordHash })
      .where(eq(users.id, userId))
      .execute();
  }
}

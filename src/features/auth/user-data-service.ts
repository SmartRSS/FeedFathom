import crypto from "node:crypto";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { sessions } from "#platform/db/schemas/sessions.ts";
import { users } from "#platform/db/schemas/users.ts";

export class UsersDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

  // Annotated rather than inferred: crypto.randomUUID() infers the
  // `${string}-${string}-...` template literal type, which promises callers
  // and test doubles a UUID shape nothing depends on.
  public async createSession(
    userId: number,
    userAgent?: null | string,
  ): Promise<string> {
    const uuid = crypto.randomUUID();
    await this.drizzleConnection.insert(sessions).values({
      sid: uuid,
      userAgent: userAgent ?? "UNKNOWN",
      userId,
    });
    return uuid;
  }

  public async deleteSession(sid: string) {
    await this.drizzleConnection.delete(sessions).where(eq(sessions.sid, sid));
  }

  public async createUser(payload: {
    email: string;
    name: string;
    passwordHash: string;
    status?: "active" | "inactive";
    activationToken?: string;
    activationTokenExpiresAt?: Date;
  }) {
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
      return (
        await this.drizzleConnection
          .insert(users)
          .values(values(false))
          .returning()
      ).at(0);
    }

    return await this.drizzleConnection.transaction(async (transaction) => {
      await transaction.execute(
        sql`lock table ${users} in share row exclusive mode`,
      );
      const existingUser = (
        await transaction.select({ id: users.id }).from(users).limit(1)
      ).at(0);

      return (
        await transaction
          .insert(users)
          .values(values(!existingUser))
          .returning()
      ).at(0);
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

  // The expiry predicate lives here rather than in a caller-side check
  // because this lookup is the one choke point every request's session
  // flows through: an expired sid resolves to no user at all, which the
  // auth plugin already answers with a 401.
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

  // The session-level counterpart of touchLastSeen: stamps activity and
  // the current User-Agent onto the row, so a session's device label
  // follows the browser across updates instead of freezing at login-time.
  // Self-guarding like touchLastSeen -- a no-op write on every request
  // except when the header changed or the staleness window elapsed -- and
  // COALESCE keeps a missing header from overwriting a known agent with
  // the UNKNOWN sentinel.
  public async refreshSession(sid: string, userAgent: null | string) {
    await this.drizzleConnection
      .update(sessions)
      .set({
        lastUsedAt: sql`NOW()`,
        userAgent: sql`COALESCE(${userAgent}, ${sessions.userAgent})`,
      })
      .where(
        and(
          eq(sessions.sid, sid),
          sql`(${sessions.lastUsedAt} < NOW() - INTERVAL '1 minute' OR ${sessions.userAgent} IS DISTINCT FROM COALESCE(${userAgent}, ${sessions.userAgent}))`,
        ),
      );
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

  // Self-guarding: the WHERE clause makes this a no-op write on every
  // request except roughly once per day per active user, so it's safe to
  // call unconditionally from the auth plugin without checking staleness
  // in application code first.
  public async touchLastSeen(userId: number) {
    await this.drizzleConnection
      .update(users)
      .set({ lastSeenAt: sql`NOW()` })
      .where(
        and(
          eq(users.id, userId),
          sql`${users.lastSeenAt} < NOW() - INTERVAL '1 day'`,
        ),
      );
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
   */
  public async completePasswordReset(userId: number, passwordHash: string) {
    await this.drizzleConnection.transaction(async (transaction) => {
      await transaction
        .update(users)
        .set({
          password: passwordHash,
          passwordResetTokenExpiresAt: null,
          passwordResetTokenHash: null,
        })
        .where(eq(users.id, userId));
      await transaction.delete(sessions).where(eq(sessions.userId, userId));
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

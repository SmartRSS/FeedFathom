import crypto from "node:crypto";
import {
  and,
  desc,
  eq,
  exists,
  gt,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { SESSION_TTL_DAYS, sessions } from "#platform/db/schemas/sessions.ts";
import { users } from "#platform/db/schemas/users.ts";
import { digestToken, issueToken } from "#features/auth/account-tokens.ts";
import { passwordResetLifetime } from "#shared/contracts/limits.ts";

export function authenticateStatement(
  db: Pick<
    BunSQLDatabase<typeof schema>,
    "$with" | "select" | "update" | "with"
  >,
  sid: string,
  userAgent: null | string,
  touch = true,
) {
  const resolve = db
    .select({
      email: users.email,
      id: users.id,
      isAdmin: users.isAdmin,
      name: users.name,
      status: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.sid, sid),
        gt(sessions.expiresAt, sql`NOW()`),
        eq(users.status, "active"),
      ),
    );
  if (!touch) return resolve;

  const resolved = db.$with("resolved").as(resolve);
  const nextUserAgent = sql`COALESCE(${userAgent}, ${sessions.userAgent})`;
  const touchSession = db.$with("touch_session").as(
    db
      .update(sessions)
      .set({ lastUsedAt: sql`NOW()`, userAgent: nextUserAgent })
      .where(
        and(
          eq(sessions.sid, sid),
          exists(db.select({ id: resolved.id }).from(resolved)),
          or(
            lt(sessions.lastUsedAt, sql`NOW() - INTERVAL '1 minute'`),
            sql`${sessions.userAgent} IS DISTINCT FROM ${nextUserAgent}`,
          ),
        ),
      ),
  );
  const touchUser = db.$with("touch_user").as(
    db
      .update(users)
      .set({ lastSeenAt: sql`NOW()` })
      .where(
        and(
          eq(users.id, db.select({ id: resolved.id }).from(resolved)),
          lt(users.lastSeenAt, sql`NOW() - INTERVAL '1 day'`),
        ),
      ),
  );
  return db.with(resolved, touchSession, touchUser).select().from(resolved);
}

const unknownUserAgent = "UNKNOWN";

export class UsersDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

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
        expiresAt: sql`NOW() + make_interval(days => ${SESSION_TTL_DAYS})`,
        sid: uuid,
        userAgent: userAgent ?? unknownUserAgent,
        userId,
      });
      return uuid;
    });
  }

  public async deleteSession(sid: string) {
    await this.drizzleConnection.delete(sessions).where(eq(sessions.sid, sid));
  }

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

  public async withdrawActivationToken(token: string) {
    await this.drizzleConnection
      .update(users)
      .set({ activationToken: null, activationTokenExpiresAt: null })
      .where(
        and(eq(users.activationToken, token), eq(users.status, "inactive")),
      );
  }

  public async activate(token: string): Promise<boolean> {
    const activated = await this.drizzleConnection
      .update(users)
      .set({
        activationToken: null,
        activationTokenExpiresAt: null,
        status: "active",
      })
      .where(
        and(
          eq(users.activationToken, token),
          eq(users.status, "inactive"),
          gt(users.activationTokenExpiresAt, sql`now()`),
        ),
      )
      .returning({ id: users.id });
    return activated.length > 0;
  }

  public async authenticate(
    sid: string,
    userAgent: null | string,
    touch = true,
  ) {
    const rows = await authenticateStatement(
      this.drizzleConnection,
      sid,
      userAgent,
      touch,
    );
    return rows.at(0);
  }

  public async listSessions(userId: number, currentSid: string) {
    return await this.drizzleConnection
      .select({
        createdAt: sessions.createdAt,
        current: sql<boolean>`${sessions.sid} = ${currentSid}`,
        expiresAt: sessions.expiresAt,
        id: sessions.id,
        lastUsedAt: sessions.lastUsedAt,
        userAgent: sql<
          null | string
        >`NULLIF(${sessions.userAgent}, ${unknownUserAgent})`,
      })
      .from(sessions)
      .where(
        and(eq(sessions.userId, userId), gt(sessions.expiresAt, sql`NOW()`)),
      )
      .orderBy(desc(sessions.lastUsedAt), desc(sessions.id));
  }

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
    return await this.drizzleConnection.$count(users);
  }

  public async startPasswordReset(userId: number): Promise<string> {
    const { expiresAt, token } = issueToken(passwordResetLifetime.ms);
    await this.drizzleConnection
      .update(users)
      .set({
        passwordResetTokenExpiresAt: expiresAt,
        passwordResetTokenHash: digestToken(token),
      })
      .where(eq(users.id, userId));
    return token;
  }

  public async findUserByPasswordResetToken(tokenHash: string) {
    return (
      await this.drizzleConnection
        .select()
        .from(users)
        .where(
          and(
            eq(users.passwordResetTokenHash, tokenHash),
            eq(users.status, "active"),
            gt(users.passwordResetTokenExpiresAt, sql`now()`),
          ),
        )
        .limit(1)
    ).at(0);
  }

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

  public async updatePassword(
    userId: number,
    currentHash: string,
    passwordHash: string,
    currentSid: string,
  ): Promise<boolean> {
    return await this.drizzleConnection.transaction(async (transaction) => {
      const updated = await transaction
        .update(users)
        .set({ password: passwordHash })
        .where(and(eq(users.id, userId), eq(users.password, currentHash)))
        .returning({ id: users.id });
      if (!updated.length) return false;
      await transaction
        .delete(sessions)
        .where(and(eq(sessions.userId, userId), ne(sessions.sid, currentSid)));
      return true;
    });
  }
}

import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { sessions } from "#platform/db/schemas/sessions.ts";
import { users } from "#platform/db/schemas/users.ts";

export class UsersDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

  public async createSession(userId: number, userAgent?: null | string) {
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
        .where(eq(sessions.sid, sid))
        .leftJoin(sessions, eq(sessions.userId, users.id))
        .limit(1)
    ).at(0);
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

  public async updatePassword(userId: number, passwordHash: string) {
    return await this.drizzleConnection
      .update(users)
      .set({ password: passwordHash })
      .where(eq(users.id, userId))
      .execute();
  }
}

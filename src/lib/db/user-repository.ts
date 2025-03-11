import crypto from "node:crypto";
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { sessions, users } from "../schema.ts";

export class UsersRepository {
  constructor(private readonly drizzleConnection: BunSQLDatabase) {}

  public async createSession(userId: number, userAgent?: null | string) {
    const uuid = crypto.randomUUID();
    await this.drizzleConnection.insert(sessions).values({
      sid: uuid,
      userAgent: userAgent ?? "UNKNOWN",
      userId,
    });
    return uuid;
  }

  public async createUser(payload: {
    email: string;
    name: string;
    passwordHash: string;
  }) {
    return (
      await this.drizzleConnection
        .insert(users)
        .values({
          email: payload.email,
          name: payload.name,
          password: payload.passwordHash,
        })
        .returning()
    ).at(0);
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

  public async getUserBySid(sid: string) {
    const { password: _password, ...rest } = getTableColumns(users);
    return (
      await this.drizzleConnection
        .select({ ...rest })
        .from(users)
        .where(eq(sessions.sid, sid))
        .leftJoin(sessions, eq(sessions.userId, users.id))
        .limit(1)
    ).at(0);
  }

  public async getUserCount(): Promise<number> {
    const result = await this.drizzleConnection
      .select({
        count: sql`count(${users.id})`,
      })
      .from(users);

    return Number(result[0]?.count ?? 0);
  }

  public async makeAdmin(email: string) {
    return await this.drizzleConnection
      .update(users)
      .set({ isAdmin: true })
      .where(eq(users.email, email))
      .execute();
  }

  public async updatePassword(userId: number, passwordHash: string) {
    return await this.drizzleConnection
      .update(users)
      .set({ password: passwordHash })
      .where(eq(users.id, userId))
      .execute();
  }
}

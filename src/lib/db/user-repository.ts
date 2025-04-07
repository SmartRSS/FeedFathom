import crypto from "node:crypto";
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { sessions, users } from "../schema.ts";

export class UsersRepository {
  constructor(private readonly drizzleConnection: BunSQLDatabase | null) {}

  public async createSession(userId: number, userAgent?: null | string) {
    if (!this.drizzleConnection) {
      return null;
    }

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
    if (!this.drizzleConnection) {
      return null;
    }

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
    if (!this.drizzleConnection) {
      return null;
    }

    return (
      await this.drizzleConnection
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
    ).at(0);
  }

  public async getUserBySid(sid: string) {
    if (!this.drizzleConnection) {
      return null;
    }

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
    if (!this.drizzleConnection) {
      return 0;
    }

    const result = await this.drizzleConnection
      .select({
        count: sql`count(${users.id})`,
      })
      .from(users);

    return Number(result[0]?.count ?? 0);
  }

  public async makeAdmin(email: string) {
    if (!this.drizzleConnection) {
      return;
    }

    return await this.drizzleConnection
      .update(users)
      .set({ isAdmin: true })
      .where(eq(users.email, email))
      .execute();
  }

  public async updatePassword(userId: number, passwordHash: string) {
    if (!this.drizzleConnection) {
      return;
    }

    return await this.drizzleConnection
      .update(users)
      .set({ password: passwordHash })
      .where(eq(users.id, userId))
      .execute();
  }
}

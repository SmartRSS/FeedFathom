import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../schema";
import { eq, getTableColumns } from "drizzle-orm";
import crypto from "node:crypto";

export class UserRepository {
  constructor(private readonly drizzleConnection: PostgresJsDatabase) {}

  public async findUser(email: string) {
    return (
      await this.drizzleConnection
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1)
    ).at(0);
  }

  public async updatePassword(userId: number, passwordHash: string) {
    return await this.drizzleConnection
      .update(schema.users)
      .set({ password: passwordHash })
      .where(eq(schema.users.id, userId))
      .execute();
  }

  public async createSession(userId: number, userAgent?: string | null) {
    const uuid = crypto.randomUUID();
    await this.drizzleConnection.insert(schema.sessions).values({
      sid: uuid,
      userId,
      userAgent: userAgent ?? "UNKNOWN",
    });
    return uuid;
  }

  public async getUserBySid(sid: string) {
    const { password: _password, ...rest } = getTableColumns(schema.users);
    return (
      await this.drizzleConnection
        .select({ ...rest })
        .from(schema.users)
        .where(eq(schema.sessions.sid, sid))
        .leftJoin(schema.sessions, eq(schema.sessions.userId, schema.users.id))
        .limit(1)
    ).at(0);
  }

  public async createUser(payload: {
    name: string;
    email: string;
    passwordHash: string;
  }) {
    return (
      await this.drizzleConnection
        .insert(schema.users)
        .values({
          name: payload.name,
          email: payload.email,
          password: payload.passwordHash,
        })
        .returning()
    ).at(0);
  }
}

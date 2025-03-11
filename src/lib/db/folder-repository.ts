import { and, eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { userFolders } from "../schema.ts";

export class FoldersRepository {
  public constructor(private readonly drizzleConnection: BunSQLDatabase) {}

  public async createFolder(userId: number, name: string) {
    const [folder] = await this.drizzleConnection
      .insert(userFolders)
      .values({
        name,
        userId,
      })
      .returning();
    if (!folder) {
      throw new Error("couldn't create folder");
    }

    return folder;
  }

  public async getUserFolders(userId: number) {
    return await this.drizzleConnection
      .select()
      .from(userFolders)
      .where(eq(userFolders.userId, userId));
  }

  public async removeUserFolder(userId: number, folderId: number) {
    await this.drizzleConnection
      .delete(userFolders)
      .where(and(eq(userFolders.userId, userId), eq(userFolders.id, folderId)));
  }
}

import { and, eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { userFolders } from "../schemas/userFolders";

export class FoldersDataService {
  constructor(private readonly drizzleConnection: BunSQLDatabase) {}

  public async createFolder(userId: number, name: string) {
    const [folder] = await this.drizzleConnection
      .insert(userFolders)
      .values({
        userId,
        name,
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
      .where(and(eq(userFolders.id, folderId), eq(userFolders.userId, userId)));
  }
}

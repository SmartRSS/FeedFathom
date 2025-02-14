import * as schema from "$lib/schema";
import { and, eq } from "drizzle-orm";
import { type BunSQLDatabase } from "drizzle-orm/bun-sql";

export class FoldersRepository {
  public constructor(private readonly drizzleConnection: BunSQLDatabase) {}

  public async createFolder(userId: number, name: string) {
    const [folder] = await this.drizzleConnection
      .insert(schema.userFolders)
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
    return this.drizzleConnection
      .select()
      .from(schema.userFolders)
      .where(eq(schema.userFolders.userId, userId));
  }

  public async removeUserFolder(userId: number, folderId: number) {
    await this.drizzleConnection
      .delete(schema.userFolders)
      .where(
        and(
          eq(schema.userFolders.userId, userId),
          eq(schema.userFolders.id, folderId),
        ),
      );
  }
}

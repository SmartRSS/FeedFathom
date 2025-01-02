import * as schema from "$lib/schema";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export class FolderRepository {
  public constructor(private readonly drizzleConnection: PostgresJsDatabase) {}

  public async getUserFolders(userId: number) {
    return this.drizzleConnection
      .select()
      .from(schema.userFolders)
      .where(eq(schema.userFolders.userId, userId));
  }

  public async createFolder(userId: number, name: string) {
    const [folder] = await this.drizzleConnection
      .insert(schema.userFolders)
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

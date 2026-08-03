import { and, eq, notExists } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "../schema.ts";
import { userFolders } from "../schemas/userFolders";
import { userSources } from "../schemas/userSources";

export class FoldersDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

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

  public async removeEmptyUserFolder(userId: number, folderId: number) {
    const removed = await this.drizzleConnection
      .delete(userFolders)
      .where(
        and(
          eq(userFolders.id, folderId),
          eq(userFolders.userId, userId),
          notExists(
            this.drizzleConnection
              .select({ id: userSources.id })
              .from(userSources)
              .where(eq(userSources.parentId, folderId)),
          ),
        ),
      )
      .returning({ id: userFolders.id });
    return removed.length > 0;
  }
}

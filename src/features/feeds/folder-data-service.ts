import { and, eq, notExists } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { userFolders } from "#platform/db/schemas/user-folders.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";

export class FoldersDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

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

  public async renameFolder(userId: number, folderId: number, name: string) {
    return (
      await this.drizzleConnection
        .update(userFolders)
        .set({ name })
        .where(
          and(eq(userFolders.id, folderId), eq(userFolders.userId, userId)),
        )
        .returning({ id: userFolders.id })
    ).at(0);
  }

  public async removeEmptyUserFolder(
    userId: number,
    folderId: number,
  ): Promise<"not-empty" | "not-found" | "removed"> {
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
    if (removed.length > 0) return "removed";

    // The delete's own conditions can't tell "doesn't exist/not owned"
    // apart from "exists but isn't empty" (both affect zero rows) -- a
    // follow-up existence check (ignoring emptiness) distinguishes them
    // for the caller.
    const [existing] = await this.drizzleConnection
      .select({ id: userFolders.id })
      .from(userFolders)
      .where(and(eq(userFolders.id, folderId), eq(userFolders.userId, userId)))
      .limit(1);
    return existing ? "not-empty" : "not-found";
  }
}

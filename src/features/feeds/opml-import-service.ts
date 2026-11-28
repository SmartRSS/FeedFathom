import { eq, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { OpmlNode } from "#features/feeds/opml-types.ts";
import type * as schema from "#platform/db/schema.ts";
import type { UserEventPublisher } from "#platform/user-events.ts";
import { opmlImports } from "#platform/db/schemas/opml-imports.ts";
import { userFolders } from "#platform/db/schemas/user-folders.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import type { SourceJobs } from "#features/feeds/source-jobs.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";

type PendingImportNode = {
  node: OpmlNode;
  parentId: null | number;
};

export class OpmlImportService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
    private readonly sourceJobs: Pick<SourceJobs, "refresh">,
    private readonly sourcesDataService: Pick<SourcesDataService, "addSource">,
    private readonly userEventPublisher?: Pick<UserEventPublisher, "publish">,
  ) {}

  public async insertTree(
    userId: number,
    tree: OpmlNode[],
    contentHash?: string,
  ) {
    if (!contentHash || !/^[a-f\d]{64}$/.test(contentHash))
      throw new Error("Valid OPML content hash is required");
    const sourceIds = await this.drizzleConnection.transaction(
      async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`feedfathom:opml:${userId}`}, 0))`,
        );
        await transaction
          .insert(opmlImports)
          .values({ contentHash, userId })
          .onConflictDoNothing();

        const existingFolders = await transaction
          .select({ id: userFolders.id, name: userFolders.name })
          .from(userFolders)
          .where(eq(userFolders.userId, userId))
          .orderBy(userFolders.id);
        const foldersByName = new Map<string, number>();
        for (const folder of existingFolders) {
          if (!foldersByName.has(folder.name))
            foldersByName.set(folder.name, folder.id);
        }

        const pending: PendingImportNode[] = tree
          .toReversed()
          .map((node) => ({ node, parentId: null }));
        const queued = new Set<number>();
        /* eslint-disable no-await-in-loop -- Import order determines folder membership. */
        while (pending.length) {
          const current = pending.pop();
          if (!current) break;

          if (current.node.type === "folder") {
            let folderId = foldersByName.get(current.node.name);
            if (folderId === undefined) {
              const created = (
                await transaction
                  .insert(userFolders)
                  .values({ name: current.node.name, userId })
                  .returning({ id: userFolders.id })
              ).at(0);
              if (!created) throw new Error("Failed to create OPML folder");
              folderId = created.id;
              foldersByName.set(current.node.name, folderId);
            }
            for (const child of current.node.children.toReversed())
              pending.push({ node: child, parentId: folderId });
            continue;
          }

          const source = await this.sourcesDataService.addSource(
            { homeUrl: current.node.homeUrl, url: current.node.xmlUrl },
            transaction,
          );

          const subscription = (
            await transaction
              .insert(userSources)
              .values({
                createdAt: sql`NOW()`,
                initializedAt: sql`NOW()`,
                name: current.node.name,
                parentId: current.parentId,
                sourceId: source.id,
                userId,
              })
              .onConflictDoNothing({
                target: [userSources.sourceId, userSources.userId],
              })
              .returning({ id: userSources.id })
          ).at(0);
          if (subscription) queued.add(source.id);
        }
        /* eslint-enable no-await-in-loop */
        return [...queued];
      },
    );

    if (sourceIds.length > 0) this.userEventPublisher?.publish(userId);
    await this.sourceJobs.refresh(sourceIds);
  }
}

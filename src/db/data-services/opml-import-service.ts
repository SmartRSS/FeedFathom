import { eq, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { OpmlNode } from "#shared/types/opml-types.ts";
import type * as schema from "../schema.ts";
import { opmlImports } from "../schemas/opml-imports.ts";
import { type Source, sources } from "../schemas/sources.ts";
import { userFolders } from "../schemas/user-folders.ts";
import { userSources } from "../schemas/user-sources.ts";
import type { SourcesDataService } from "./source-data-service.ts";

type PendingImportNode = {
  node: OpmlNode;
  parentId: null | number;
};

export class OpmlImportService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
    private readonly sourcesDataService: SourcesDataService,
  ) {}

  public async insertTree(
    userId: number,
    tree: OpmlNode[],
    contentHash?: string,
  ) {
    if (!contentHash || !/^[a-f\d]{64}$/.test(contentHash))
      throw new Error("Valid OPML content hash is required");
    const sourcesToQueue = await this.drizzleConnection.transaction(
      async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`feedfathom:opml:${userId}`}, 0))`,
        );
        const imported = (
          await transaction
            .insert(opmlImports)
            .values({ contentHash, userId })
            .onConflictDoNothing()
            .returning({ contentHash: opmlImports.contentHash })
        ).at(0);
        if (!imported) return [];

        const pending: PendingImportNode[] = tree
          .toReversed()
          .map((node) => ({ node, parentId: null }));
        const queued = new Map<number, Source>();
        /* eslint-disable no-await-in-loop -- Import order determines folder membership. */
        while (pending.length) {
          const current = pending.pop();
          if (!current) break;

          if (current.node.type === "folder") {
            const folder = (
              await transaction
                .insert(userFolders)
                .values({ name: current.node.name, userId })
                .returning({ id: userFolders.id })
            ).at(0);
            if (!folder) throw new Error("Failed to create OPML folder");
            for (const child of current.node.children.toReversed())
              pending.push({ node: child, parentId: folder.id });
            continue;
          }

          const insertedSource = (
            await transaction
              .insert(sources)
              .values({
                homeUrl: current.node.homeUrl,
                url: current.node.xmlUrl,
              })
              .onConflictDoNothing({ target: sources.url })
              .returning()
          ).at(0);
          const source =
            insertedSource ??
            (
              await transaction
                .select()
                .from(sources)
                .where(eq(sources.url, current.node.xmlUrl))
                .limit(1)
            ).at(0);
          if (!source) throw new Error("Failed to resolve OPML source");

          const subscription = (
            await transaction
              .insert(userSources)
              .values({
                createdAt: new Date(),
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
          if (subscription) queued.set(source.id, source);
        }
        /* eslint-enable no-await-in-loop */
        return [...queued.values()];
      },
    );

    await Promise.all(
      sourcesToQueue.map((source) =>
        this.sourcesDataService.enqueueSource(source),
      ),
    );
  }
}

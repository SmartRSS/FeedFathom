import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { OpmlNode } from "../../types/opml-types";
import type * as schema from "../schema.ts";
import { articles } from "../schemas/articles";
import { opmlImports } from "../schemas/opmlImports";
import { type Source, sources } from "../schemas/sources";
import { userFolders } from "../schemas/userFolders";
import { userSources } from "../schemas/userSources";
import type { FoldersDataService } from "./folder-data-service";
import type { SourcesDataService } from "./source-data-service";

type SubscriptionResult = {
  created?: boolean;
  initialized?: boolean;
  initializationSnapshot?: null | string;
  source: Source;
  subscriptionCreatedAt: Date;
  subscriptionId?: number;
};

type PendingImportNode = {
  node: OpmlNode;
  parentId: null | number;
};

export class UserSourcesDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
    private readonly foldersDataService: FoldersDataService,
    private readonly sourcesDataService: SourcesDataService,
  ) {}

  public async addSourceToUser(
    userId: number,
    sourcePayload: {
      homeUrl: string;
      initializationSnapshot?: null | string;
      name: string;
      parentId: null | number;
      url: string;
    },
    enqueue = true,
  ): Promise<SubscriptionResult | undefined> {
    if (sourcePayload.parentId) {
      const folders = await this.foldersDataService.getUserFolders(userId);
      if (
        !folders.some((folder) => {
          return folder.id === sourcePayload.parentId;
        })
      ) {
        console.error("no folder", folders[0]);
        return undefined;
      }
    }

    const source = await this.sourcesDataService.findOrCreateSourceByUrl(
      sourcePayload.url,
      {
        homeUrl: sourcePayload.homeUrl,
      },
    );

    if (!source) {
      throw new Error("Source not found or created");
    }

    const inserted = (
      await this.drizzleConnection
        .insert(userSources)
        .values({
          initializedAt: null,
          initializationSnapshot: sourcePayload.initializationSnapshot ?? null,
          name: sourcePayload.name,
          parentId: sourcePayload.parentId,
          sourceId: source.id,
          userId,
          createdAt: new Date(),
        })
        .onConflictDoNothing({
          target: [userSources.sourceId, userSources.userId],
        })
        .returning()
    ).at(0);
    const userSource =
      inserted ??
      (
        await this.drizzleConnection
          .select()
          .from(userSources)
          .where(
            and(
              eq(userSources.sourceId, source.id),
              eq(userSources.userId, userId),
            ),
          )
          .limit(1)
      ).at(0);

    if (!userSource)
      throw new Error("Subscription conflict resolved without a row");

    const created = inserted !== undefined;
    let initialized = userSource.initializedAt !== null;
    if (enqueue && !initialized) {
      const claim = await this.claimSubscriptionInitialization(userSource.id);
      if (claim) {
        try {
          await this.sourcesDataService.enqueueSource(source);
          initialized = await this.completeSubscriptionInitialization(
            userSource.id,
            claim,
          );
        } catch (error) {
          await this.releaseSubscriptionInitialization(userSource.id, claim);
          throw error;
        }
      }
    }
    return {
      created,
      initialized,
      initializationSnapshot: userSource.initializationSnapshot,
      source,
      subscriptionCreatedAt: userSource.createdAt,
      subscriptionId: userSource.id,
    };
  }

  public async claimSubscriptionInitialization(subscriptionId: number) {
    const owner = Bun.randomUUIDv7();
    return (
      await this.drizzleConnection
        .update(userSources)
        .set({ initializationOwner: owner, initializingAt: sql`NOW()` })
        .where(
          and(
            eq(userSources.id, subscriptionId),
            isNull(userSources.initializedAt),
            or(
              isNull(userSources.initializingAt),
              lt(userSources.initializingAt, sql`NOW() - INTERVAL '5 minutes'`),
            ),
          ),
        )
        .returning({ initializationOwner: userSources.initializationOwner })
    ).at(0)?.initializationOwner;
  }

  public async completeSubscriptionInitialization(
    subscriptionId: number,
    owner: string,
  ) {
    const completed = await this.drizzleConnection
      .update(userSources)
      .set({
        initializedAt: sql`NOW()`,
        initializationOwner: null,
        initializationSnapshot: null,
        initializingAt: null,
      })
      .where(
        and(
          eq(userSources.id, subscriptionId),
          eq(userSources.initializationOwner, owner),
          isNull(userSources.initializedAt),
        ),
      )
      .returning({ id: userSources.id });
    return completed.length > 0;
  }

  public async releaseSubscriptionInitialization(
    subscriptionId: number,
    owner: string,
  ) {
    await this.drizzleConnection
      .update(userSources)
      .set({ initializationOwner: null, initializingAt: null })
      .where(
        and(
          eq(userSources.id, subscriptionId),
          eq(userSources.initializationOwner, owner),
          isNull(userSources.initializedAt),
        ),
      );
  }

  public async removeSourceFromUser(userId: number, sourceId: number) {
    await this.drizzleConnection
      .delete(userSources)
      .where(
        and(eq(userSources.userId, userId), eq(userSources.sourceId, sourceId)),
      );
  }

  public async getUserSources(userId: number) {
    return await this.drizzleConnection
      .select({
        homeUrl: sources.homeUrl,
        id: sources.id,
        name: userSources.name,
        parentId: userSources.parentId,
        unreadArticlesCount: userSources.unreadCount,
        url: sources.url,
      })
      .from(userSources)
      .where(eq(userSources.userId, userId))
      .leftJoin(sources, eq(sources.id, userSources.sourceId))
      .orderBy(userSources.name);
  }

  /**
   * Recomputes and stores unreadCount for every subscriber of the given
   * sources. Call after articles change (new/updated) for those sources.
   */
  public async recomputeUnreadCounts(sourceIds: number[]) {
    if (sourceIds.length === 0) return;
    await this.drizzleConnection.execute(sql`
      UPDATE user_sources us
      SET unread_count = counts.unread
      FROM (
        SELECT us2.id,
          (
            coalesce(count(a.id), 0) -
            coalesce(count(CASE
              WHEN ua.deleted_at IS NOT NULL
              OR (
                ua.read_at IS NOT NULL
                AND (a.updated_at IS NULL OR ua.read_at >= a.updated_at)
              )
              THEN 1
            END), 0)
          )::int AS unread
        FROM user_sources us2
        LEFT JOIN articles a
          ON a.source_id = us2.source_id AND a.last_seen_in_feed_at >= us2.created_at
        LEFT JOIN user_articles ua
          ON ua.user_id = us2.user_id AND ua.article_id = a.id
        WHERE us2.source_id IN ${sourceIds}
        GROUP BY us2.id
      ) counts
      WHERE us.id = counts.id
    `);
  }

  /**
   * Recomputes and stores unreadCount for one user's subscriptions to the
   * given sources. Call after a user's own read/delete state changes.
   */
  public async recomputeUnreadCountsForUser(
    userId: number,
    sourceIds: number[],
  ) {
    if (sourceIds.length === 0) return;
    await this.drizzleConnection.execute(sql`
      UPDATE user_sources us
      SET unread_count = counts.unread
      FROM (
        SELECT us2.id,
          (
            coalesce(count(a.id), 0) -
            coalesce(count(CASE
              WHEN ua.deleted_at IS NOT NULL
              OR (
                ua.read_at IS NOT NULL
                AND (a.updated_at IS NULL OR ua.read_at >= a.updated_at)
              )
              THEN 1
            END), 0)
          )::int AS unread
        FROM user_sources us2
        LEFT JOIN articles a
          ON a.source_id = us2.source_id AND a.last_seen_in_feed_at >= us2.created_at
        LEFT JOIN user_articles ua
          ON ua.user_id = us2.user_id AND ua.article_id = a.id
        WHERE us2.user_id = ${userId} AND us2.source_id IN ${sourceIds}
        GROUP BY us2.id
      ) counts
      WHERE us.id = counts.id
    `);
  }

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

  public async cleanup() {
    await this.drizzleConnection
      .delete(sources)
      .where(
        notInArray(
          sources.id,
          this.drizzleConnection
            .selectDistinct({ id: userSources.sourceId })
            .from(userSources),
        ),
      );

    const articlesBeforeSubscription = this.drizzleConnection
      .select({ id: articles.id })
      .from(articles)
      .leftJoin(
        this.drizzleConnection
          .select({
            sourceId: userSources.sourceId,
            earliestSubscription: sql<Date>`min(${userSources.createdAt})`.as(
              "earliest_subscription",
            ),
          })
          .from(userSources)
          .groupBy(userSources.sourceId)
          .as("earliest_subs"),
        eq(articles.sourceId, sql`earliest_subs.source_id`),
      )
      .where(
        and(
          sql`earliest_subs.source_id IS NOT NULL`,
          sql`${articles.lastSeenInFeedAt} < earliest_subs.earliest_subscription`,
        ),
      );

    await this.drizzleConnection
      .delete(articles)
      .where(inArray(articles.id, articlesBeforeSubscription));
  }
}

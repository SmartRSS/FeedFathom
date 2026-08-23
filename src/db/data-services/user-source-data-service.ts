import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { type Source, sources } from "#platform/db/schemas/sources.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { FoldersDataService } from "./folder-data-service.ts";

type SubscriptionResult = {
  created?: boolean;
  initialized?: boolean;
  initializationSnapshot?: null | string;
  source: Source;
  subscriptionCreatedAt: Date;
  subscriptionId: number;
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
      kind?: "email" | "feed" | undefined;
      name: string;
      parentId: null | number;
      url: string;
    },
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
        kind: sourcePayload.kind,
      },
    );

    if (!source) {
      throw new Error("Source not found or created");
    }

    const inserted = (
      await this.drizzleConnection
        .insert(userSources)
        .values({
          createdAt: new Date(),
          initializationSnapshot: sourcePayload.initializationSnapshot ?? null,
          initializedAt: null,
          name: sourcePayload.name,
          parentId: sourcePayload.parentId,
          sourceId: source.id,
          userId,
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
    const initialized = userSource.initializedAt !== null;
    return {
      created,
      initializationSnapshot: userSource.initializationSnapshot,
      initialized,
      source,
      subscriptionCreatedAt: userSource.createdAt,
      subscriptionId: userSource.id,
    };
  }

  /**
   * Runs `work` under the subscription's initialization lease: claim, run
   * work, then complete (or release on failure). Returns "in-progress" when
   * another caller currently holds the lease, "already-initialized" when the
   * subscription was already initialized before this call, or the result of
   * `work` when this call claimed and completed the lease itself.
   */
  public async withSubscriptionInitializationLease<T>(
    subscriptionId: number,
    work: () => Promise<T>,
  ): Promise<
    | { outcome: "already-initialized" }
    | { outcome: "claimed"; result: T }
    | { outcome: "in-progress" }
  > {
    const owner = await this.claimSubscriptionInitialization(subscriptionId);
    if (!owner) {
      const row = (
        await this.drizzleConnection
          .select({ initializedAt: userSources.initializedAt })
          .from(userSources)
          .where(eq(userSources.id, subscriptionId))
          .limit(1)
      ).at(0);
      return {
        outcome: row?.initializedAt ? "already-initialized" : "in-progress",
      };
    }
    try {
      const result = await work();
      const completed = await this.completeSubscriptionInitialization(
        subscriptionId,
        owner,
      );
      if (!completed)
        throw new Error("Subscription initialization lease expired");
      return { outcome: "claimed", result };
    } catch (error) {
      await this.releaseSubscriptionInitialization(subscriptionId, owner);
      throw error;
    }
  }

  private async claimSubscriptionInitialization(subscriptionId: number) {
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

  private async completeSubscriptionInitialization(
    subscriptionId: number,
    owner: string,
  ) {
    const completed = await this.drizzleConnection
      .update(userSources)
      .set({
        initializationOwner: null,
        initializationSnapshot: null,
        initializedAt: sql`NOW()`,
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

  private async releaseSubscriptionInitialization(
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

  /**
   * Renames a subscription and/or moves it between folders -- both live on
   * user_sources, one row per subscriber, so this never touches the shared
   * `sources` row (url/homeUrl) other subscribers depend on. Returns
   * undefined for an unowned folder (mirrors addSourceToUser) or a source
   * the user isn't actually subscribed to.
   */
  public async updateUserSource(
    userId: number,
    sourceId: number,
    changes: { name: string; parentId: null | number },
  ) {
    if (changes.parentId) {
      const folders = await this.foldersDataService.getUserFolders(userId);
      if (!folders.some((folder) => folder.id === changes.parentId)) {
        return undefined;
      }
    }
    return (
      await this.drizzleConnection
        .update(userSources)
        .set({ name: changes.name, parentId: changes.parentId })
        .where(
          and(
            eq(userSources.userId, userId),
            eq(userSources.sourceId, sourceId),
          ),
        )
        .returning({ id: userSources.sourceId })
    ).at(0);
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
   * Recomputes and stores unreadCount for subscriptions to the given
   * sources -- for every subscriber when `userId` is omitted (call after
   * articles change for those sources), or for just that user's own
   * subscriptions when given (call after their read/delete state changes).
   */
  public async recomputeUnreadCounts(sourceIds: number[], userId?: number) {
    if (sourceIds.length === 0) return;
    const userFilter =
      userId === undefined ? sql`` : sql`AND us2.user_id = ${userId}`;
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
        WHERE us2.source_id IN ${sourceIds} ${userFilter}
        GROUP BY us2.id
      ) counts
      WHERE us.id = counts.id
    `);
  }
}

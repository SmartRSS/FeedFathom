import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { type Source, sources } from "#platform/db/schemas/sources.ts";
import { userFolders } from "#platform/db/schemas/user-folders.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { unreadCondition } from "#features/feeds/article-read-state.ts";

type SubscriptionResult = {
  initialized?: boolean;
  initializationSnapshot: null | string;
  source: Source;
  subscriptionCreatedAt: Date;
  subscriptionId: number;
};

export class UserSourcesDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
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
    if (!(await this.ownsFolder(userId, sourcePayload.parentId))) {
      console.error(
        `Subscription refused: folder ${sourcePayload.parentId} is not one of user ${userId}'s`,
      );
      return undefined;
    }

    const source = await this.sourcesDataService.addSource({
      homeUrl: sourcePayload.homeUrl,
      kind: sourcePayload.kind,
      url: sourcePayload.url,
    });

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

    return {
      initializationSnapshot: userSource.initializationSnapshot,
      initialized: userSource.initializedAt !== null,
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
    if (!(await this.ownsFolder(userId, changes.parentId))) return undefined;
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

  // The root (null) is everyone's; any other folder must be the user's own.
  private async ownsFolder(userId: number, folderId: null | number) {
    if (!folderId) return true;
    const owned = await this.drizzleConnection
      .select({ id: userFolders.id })
      .from(userFolders)
      .where(and(eq(userFolders.id, folderId), eq(userFolders.userId, userId)))
      .limit(1);
    return owned.length > 0;
  }

  public async removeSourceFromUser(userId: number, sourceId: number) {
    await this.drizzleConnection
      .delete(userSources)
      .where(
        and(eq(userSources.userId, userId), eq(userSources.sourceId, sourceId)),
      );
  }

  /**
   * Snoozes (or un-snoozes, with null) one user's subscription to a source --
   * a per-user, per-source timestamp and nothing else (#725). Parsing and
   * saving continue unchanged during the pause; suppression happens at read
   * time, so this write touches no article state and no unread count.
   * Returns undefined for a source the user isn't subscribed to.
   */
  public async setSourceSnooze(
    userId: number,
    sourceId: number,
    pausedUntil: Date | null,
  ) {
    return (
      await this.drizzleConnection
        .update(userSources)
        .set({ pausedUntil })
        .where(
          and(
            eq(userSources.userId, userId),
            eq(userSources.sourceId, sourceId),
          ),
        )
        .returning({
          id: userSources.sourceId,
          pausedUntil: userSources.pausedUntil,
        })
    ).at(0);
  }

  public async getUserSourceIds(userId: number): Promise<number[]> {
    const rows = await this.drizzleConnection
      .select({ id: userSources.sourceId })
      .from(userSources)
      .where(eq(userSources.userId, userId));
    return rows.map((row) => row.id);
  }

  public async getUserSources(userId: number) {
    return await this.drizzleConnection
      .select({
        // Content fingerprint, not the icon itself -- lets the favicon URL
        // change exactly when RefreshFavicon changes the icon, so the SW and
        // browser can cache the response forever instead of re-asking.
        faviconFingerprint: sql<string | null>`md5(${sources.favicon})`,
        homeUrl: sources.homeUrl,
        id: sources.id,
        kind: sources.kind,
        name: userSources.name,
        parentId: userSources.parentId,
        pausedUntil: userSources.pausedUntil,
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
      userId === undefined ? sql`` : sql`AND us.user_id = ${userId}`;
    // One correlated count per subscription, so user_articles is read by its
    // primary-key prefix (user_id, source_id) for that subscription alone. As
    // a single join across every subscriber the planner hash-joined it, and
    // each feed fetch sequentially scanned every user's read state (#1035).
    await this.drizzleConnection.execute(sql`
      UPDATE user_sources us
      SET unread_count = (
        -- Counting what is unread, rather than subtracting what is not, so
        -- this is literally the same expression the article list filters on
        -- (see article-read-state.ts).
        SELECT count(*)::int
        FROM articles a
        LEFT JOIN user_articles ua
          ON ua.user_id = us.user_id
          AND ua.source_id = us.source_id AND ua.guid = a.guid
        WHERE a.source_id = us.source_id
          AND a.last_seen_in_feed_at >= us.created_at
          AND ${unreadCondition({
            articleUpdatedAt: sql.raw("a.updated_at"),
            deletedAt: sql.raw("ua.deleted_at"),
            readAt: sql.raw("ua.read_at"),
            userId: sql.raw("ua.user_id"),
          })}
      )
      WHERE us.source_id IN ${sourceIds} ${userFilter}
    `);
  }
}

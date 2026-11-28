import { and, count, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import type { UserEventPublisher } from "#platform/user-events.ts";
import { isSnoozed } from "#shared/util/snooze.ts";
import { articles } from "#platform/db/schemas/articles.ts";
import { type Source, sources } from "#platform/db/schemas/sources.ts";
import { userArticles } from "#platform/db/schemas/user-articles.ts";
import { userFolders } from "#platform/db/schemas/user-folders.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import {
  hasSqlState,
  type SourcesDataService,
} from "#features/feeds/source-data-service.ts";
import {
  subscriptionSeesArticle,
  unreadCondition,
} from "#features/feeds/article-read-state.ts";

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
    private readonly sourcesDataService: Pick<
      SourcesDataService,
      "addSource" | "findSourceByUrl"
    >,
    private readonly userEventPublisher?: Pick<UserEventPublisher, "publish">,
  ) {}

  public async addSourceToUser(
    userId: number,
    sourcePayload: {
      initializationSnapshot?: null | string;
      name: string;
      parentId: null | number;
      url: string;
    } & (
      | {
          homeUrl: string;
          kind: "email";
          minted: boolean;
        }
      | { homeUrl?: string | undefined; kind?: "feed" }
    ),
  ): Promise<"refused" | SubscriptionResult | undefined> {
    if (!(await this.ownsFolder(userId, sourcePayload.parentId))) {
      console.error(
        `Subscription refused: folder ${sourcePayload.parentId} is not one of user ${userId}'s`,
      );
      return undefined;
    }
    try {
      return await this.subscribe(userId, sourcePayload);
    } catch (error) {
      if (!hasSqlState(error, "23503")) throw error;
      return await this.subscribe(userId, sourcePayload);
    }
  }

  private async subscribe(
    userId: number,
    sourcePayload: Parameters<UserSourcesDataService["addSourceToUser"]>[1],
  ): Promise<"refused" | SubscriptionResult> {
    let source: Source | undefined;
    if (sourcePayload.kind !== "email") {
      source = await this.sourcesDataService.addSource({
        homeUrl: sourcePayload.homeUrl,
        url: sourcePayload.url,
      });
    } else if (sourcePayload.minted) {
      source = await this.sourcesDataService.addSource({
        homeUrl: sourcePayload.homeUrl,
        kind: "email",
        reservedBy: userId,
        url: sourcePayload.url,
      });
    } else {
      source = await this.sourcesDataService.findSourceByUrl(sourcePayload.url);
    }
    if (!source) return "refused";
    if (
      source.kind === "email" &&
      source.reservedBy !== userId &&
      !(await this.isSubscribed(userId, source.id))
    )
      return "refused";

    const backdated = source.kind === "email" && source.reservedBy === userId;
    const inserted = (
      await this.drizzleConnection
        .insert(userSources)
        .values({
          createdAt: backdated ? source.createdAt : sql`NOW()`,
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
    if (inserted && backdated)
      await this.recomputeUnreadCounts([source.id], userId);
    if (inserted) this.userEventPublisher?.publish(userId);

    return {
      initializationSnapshot: userSource.initializationSnapshot,
      initialized: userSource.initializedAt !== null,
      source,
      subscriptionCreatedAt: userSource.createdAt,
      subscriptionId: userSource.id,
    };
  }

  public async isSubscribed(userId: number, sourceId: number) {
    const rows = await this.drizzleConnection
      .select({ id: userSources.id })
      .from(userSources)
      .where(
        and(eq(userSources.sourceId, sourceId), eq(userSources.userId, userId)),
      )
      .limit(1);
    return rows.length > 0;
  }

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
    this.userEventPublisher?.publish(userId);
  }

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
        faviconFingerprint: sources.faviconHash,
        homeUrl: sources.homeUrl,
        id: sources.id,
        kind: sources.kind,
        lastSuccess: sources.lastSuccess,
        name: userSources.name,
        parentId: userSources.parentId,
        pausedUntil: userSources.pausedUntil,
        recentFailureDetails: sources.recentFailureDetails,
        recentFailures: sources.recentFailures,
        unreadArticlesCount: userSources.unreadCount,
        url: sources.url,
      })
      .from(userSources)
      .where(eq(userSources.userId, userId))
      .innerJoin(sources, eq(sources.id, userSources.sourceId))
      .orderBy(userSources.name);
  }

  public async recomputeUnreadCounts(
    sourceIds: number[],
    userId?: number,
  ): Promise<Record<string, number> | undefined> {
    if (sourceIds.length === 0) return userId === undefined ? undefined : {};
    const unread = this.drizzleConnection
      .select({ count: count() })
      .from(articles)
      .leftJoin(
        userArticles,
        and(
          eq(userArticles.userId, userSources.userId),
          eq(userArticles.sourceId, userSources.sourceId),
          eq(userArticles.guid, articles.guid),
        ),
      )
      .where(
        and(
          eq(articles.sourceId, userSources.sourceId),
          subscriptionSeesArticle(
            articles.lastSeenInFeedAt,
            userSources.createdAt,
          ),
          unreadCondition({
            articleUpdatedAt: articles.updatedAt,
            deletedAt: userArticles.deletedAt,
            readAt: userArticles.readAt,
            userId: userArticles.userId,
          }),
        ),
      );
    const recount = this.drizzleConnection
      .update(userSources)
      .set({ unreadCount: sql`(${unread})` })
      .where(
        and(
          inArray(userSources.sourceId, sourceIds),
          userId === undefined ? undefined : eq(userSources.userId, userId),
        ),
      );
    if (userId === undefined) {
      await recount;
      return undefined;
    }
    const rows = await recount.returning({
      pausedUntil: userSources.pausedUntil,
      sourceId: userSources.sourceId,
      unreadCount: userSources.unreadCount,
    });
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[String(row.sourceId)] = isSnoozed(row.pausedUntil)
        ? 0
        : row.unreadCount;
    }
    return counts;
  }
}

import { aliasedTable, and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { articlePageSize } from "#shared/contracts/limits.ts";
import {
  articleFilterCondition,
  readCondition,
  subscriptionSeesArticle,
  type ArticleFilter,
} from "#features/feeds/article-read-state.ts";
import { userSources } from "#platform/db/schema.ts";
import type * as schema from "#platform/db/schema.ts";
import { type ArticleInsert, articles } from "#platform/db/schemas/articles.ts";
import { userArticles } from "#platform/db/schemas/user-articles.ts";
import { lastSeenBumpThrottleHours } from "#features/feeds/retention.ts";

function userArticleStateJoin(userId: number) {
  return and(
    eq(userArticles.userId, userId),
    eq(userArticles.sourceId, articles.sourceId),
    eq(userArticles.guid, articles.guid),
  );
}

const cursorRow = aliasedTable(articles, "cursor_row");

function userArticleAccessJoin(userId: number) {
  return and(
    eq(userSources.userId, userId),
    eq(userSources.sourceId, articles.sourceId),
    subscriptionSeesArticle(articles.lastSeenInFeedAt, userSources.createdAt),
  );
}

export class ArticlesDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

  public async getUserArticle(articleId: number, userId: number) {
    return (
      await this.drizzleConnection
        .select({
          author: articles.author,
          content: articles.content,
          enclosures: articles.enclosures,
          guid: articles.guid,
          id: articles.id,
          lastSeenInFeedAt: articles.lastSeenInFeedAt,
          publishedAt: articles.publishedAt,
          sourceId: articles.sourceId,
          title: articles.title,
          updatedAt: articles.updatedAt,
          url: articles.url,
        })
        .from(articles)
        .innerJoin(userSources, userArticleAccessJoin(userId))
        .where(eq(articles.id, articleId))
        .limit(1)
    ).at(0);
  }

  public async getUserArticlesForSources(
    sourceIds: number[],
    userId: number,
    cursor?: number,
    filter: ArticleFilter = "unread",
    options: {
      allSubscribed?: boolean;
      folderId?: number;
      publishedWithinHours?: number;
      query?: string;
    } = {},
  ) {
    if (
      !options.allSubscribed &&
      options.folderId === undefined &&
      sourceIds.length === 0
    ) {
      return [];
    }

    const readStateColumns = {
      articleUpdatedAt: articles.updatedAt,
      deletedAt: userArticles.deletedAt,
      readAt: userArticles.readAt,
      userId: userArticles.userId,
    };
    const page = this.drizzleConnection
      .select({
        id: articles.id,
        publishedAt: articles.publishedAt,
        read: sql<boolean>`${readCondition(readStateColumns)}`.as("read"),
      })
      .from(articles)
      .leftJoin(userArticles, userArticleStateJoin(userId))
      .leftJoin(userSources, userArticleAccessJoin(userId))
      .where(
        and(
          ...(options.allSubscribed
            ? []
            : options.folderId === undefined
              ? [inArray(articles.sourceId, sourceIds)]
              : [eq(userSources.parentId, options.folderId)]),
          ...(options.publishedWithinHours
            ? [
                sql`${articles.publishedAt} >= NOW() - (${options.publishedWithinHours} * INTERVAL '1 hour')`,
              ]
            : []),
          ...(options.query
            ? [
                sql`${articles.searchVector} @@ plainto_tsquery('english', ${options.query})`,
              ]
            : []),
          articleFilterCondition(filter, readStateColumns),
          ...(filter === "unread"
            ? [
                sql`(${userSources.pausedUntil} IS NULL OR ${userSources.pausedUntil} <= NOW())`,
              ]
            : []),
          sql`${userSources.createdAt} IS NOT NULL`,
          cursor
            ? sql`(${articles.publishedAt}, ${articles.id}) < (
                (SELECT ${cursorRow.publishedAt} FROM ${articles} ${cursorRow} WHERE ${cursorRow.id} = ${cursor}),
                ${cursor}
              )`
            : undefined,
        ),
      )
      .orderBy(desc(articles.publishedAt), desc(articles.id))
      .limit(articlePageSize)
      .as("page");

    const loadedArticles = await this.drizzleConnection
      .select({
        author: articles.author,
        id: articles.id,
        publishedAt: articles.publishedAt,
        read: page.read,
        revision: sql<null | string>`${articles.updatedAt}::text`,
        sourceId: articles.sourceId,
        title: articles.title,
        url: articles.url,
      })
      .from(page)
      .innerJoin(articles, eq(articles.id, page.id))
      .orderBy(desc(page.publishedAt), desc(page.id));

    return loadedArticles;
  }

  public async batchUpsertArticles(
    articlePayloads: ArticleInsert[],
  ): Promise<number> {
    const deduped = [
      ...new Map(
        articlePayloads.map((payload) => [
          `${payload.sourceId} ${payload.guid}`,
          payload,
        ]),
      ).values(),
    ];

    const fieldChange = sql`
      excluded.author IS DISTINCT FROM ${articles.author}
      OR excluded.content IS DISTINCT FROM ${articles.content}
      OR excluded.title IS DISTINCT FROM ${articles.title}
      OR excluded.url IS DISTINCT FROM ${articles.url}
      OR (
        excluded.updated_at IS NOT NULL
        AND excluded.published_at IS DISTINCT FROM ${articles.publishedAt}
      )
    `;
    const timestampAdvance = sql`
      excluded.updated_at IS NOT NULL
      AND (
        ${articles.updatedAt} IS NULL
        OR excluded.updated_at > ${articles.updatedAt}
      )
    `;
    const BATCH_SIZE = 100;
    const batches = [];
    for (const sourcePayloads of Map.groupBy(
      deduped,
      (payload) => payload.sourceId,
    ).values()) {
      for (let i = 0; i < sourcePayloads.length; i += BATCH_SIZE) {
        batches.push(sourcePayloads.slice(i, i + BATCH_SIZE));
      }
    }

    let changed = 0;
    for (const batch of batches) {
      const sourceId = batch[0]!.sourceId;
      const latestSubscription = sql`(
        SELECT MAX(${userSources.createdAt})
        FROM ${userSources}
        WHERE ${userSources.sourceId} = ${sourceId}
      )`;
      const updatedAtText = sql<null | string>`${articles.updatedAt}::text`;
      // eslint-disable-next-line no-await-in-loop -- Sequential batches bound database pressure.
      const before = await this.drizzleConnection
        .select({
          guid: articles.guid,
          hidden: sql<boolean>`COALESCE(NOT ${subscriptionSeesArticle(articles.lastSeenInFeedAt, latestSubscription)}, false)`,
          updatedAt: updatedAtText,
        })
        .from(articles)
        .where(
          and(
            eq(articles.sourceId, sourceId),
            inArray(
              articles.guid,
              batch.map((payload) => payload.guid),
            ),
          ),
        );
      const beforeByGuid = new Map(before.map((row) => [row.guid, row]));

      // eslint-disable-next-line no-await-in-loop -- Sequential batches bound database pressure.
      const written = await this.drizzleConnection
        .insert(articles)
        .values(batch)
        .onConflictDoUpdate({
          set: {
            author: sql`excluded.author`,
            content: sql`excluded.content`,
            enclosures: sql`excluded.enclosures`,
            lastSeenInFeedAt: sql`excluded.last_seen_in_feed_at`,
            publishedAt: sql`
              CASE
                WHEN excluded.updated_at IS NOT NULL THEN excluded.published_at
                ELSE ${articles.publishedAt}
              END
            `,
            title: sql`excluded.title`,
            updatedAt: sql`
              CASE
                WHEN ${fieldChange} THEN
                  CASE
                    WHEN ${timestampAdvance} THEN excluded.updated_at
                    ELSE GREATEST(
                      excluded.last_seen_in_feed_at,
                      COALESCE(
                        ${articles.updatedAt} + INTERVAL '1 microsecond',
                        '-infinity'::timestamp
                      )
                    )
                  END
                WHEN ${timestampAdvance} THEN excluded.updated_at
                ELSE ${articles.updatedAt}
              END
            `,
            url: sql`excluded.url`,
          },
          setWhere: sql`
            excluded.last_seen_in_feed_at >= ${articles.lastSeenInFeedAt}
            AND (
              ${fieldChange}
              OR ${timestampAdvance}
              OR ${articles.lastSeenInFeedAt} < GREATEST(
                excluded.last_seen_in_feed_at - ${lastSeenBumpThrottleHours} * INTERVAL '1 hour',
                ${latestSubscription}
              )
            )
          `,
          target: [articles.sourceId, articles.guid],
        })
        .returning({ guid: articles.guid, updatedAt: updatedAtText });

      for (const row of written) {
        const previous = beforeByGuid.get(row.guid);
        if (
          previous === undefined ||
          previous.hidden ||
          previous.updatedAt !== row.updatedAt
        ) {
          changed++;
        }
      }
    }
    return changed;
  }

  public async setUserArticlesRead(
    articleIdList: number[],
    userId: number,
    read: boolean,
  ): Promise<{ articleIds: number[]; sourceIds: number[] }> {
    return await this.markUserArticles(articleIdList, userId, {
      readAt: read ? new Date() : null,
    });
  }

  public async removeUserArticles(
    articleIdList: number[],
    userId: number,
  ): Promise<{ articleIds: number[]; sourceIds: number[] }> {
    return await this.markUserArticles(articleIdList, userId, {
      deletedAt: new Date(),
    });
  }

  private async markUserArticles(
    articleIdList: number[],
    userId: number,
    mark: { deletedAt: Date } | { readAt: Date | null },
  ): Promise<{ articleIds: number[]; sourceIds: number[] }> {
    if (articleIdList.length === 0) {
      return { articleIds: [], sourceIds: [] };
    }

    return await this.drizzleConnection.transaction(async (trx) => {
      const authorizedArticles = await trx
        .selectDistinct({
          guid: articles.guid,
          id: articles.id,
          sourceId: articles.sourceId,
        })
        .from(articles)
        .innerJoin(userSources, userArticleAccessJoin(userId))
        .where(inArray(articles.id, articleIdList));

      if (authorizedArticles.length === 0) {
        return { articleIds: [], sourceIds: [] };
      }

      await trx
        .insert(userArticles)
        .values(
          authorizedArticles.map((row) =>
            Object.assign(
              { guid: row.guid, sourceId: row.sourceId, userId },
              mark,
            ),
          ),
        )
        .onConflictDoUpdate({
          set: mark,
          target: [
            userArticles.userId,
            userArticles.sourceId,
            userArticles.guid,
          ],
        });

      return {
        articleIds: authorizedArticles.map((row) => row.id),
        sourceIds: [...new Set(authorizedArticles.map((row) => row.sourceId))],
      };
    });
  }
}

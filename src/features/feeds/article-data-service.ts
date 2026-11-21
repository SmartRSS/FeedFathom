import { Type } from "typebox";
import Schema from "typebox/schema";
import { aliasedTable, and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { articlePageSize } from "#shared/contracts/limits.ts";
import { dateType } from "#shared/validation/typebox-policy.ts";
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

const markedArticleRowsCheck = Schema.Compile(
  Type.Array(
    Type.Object(
      { id: Type.Integer(), sourceId: Type.Integer() },
      { additionalProperties: false },
    ),
  ),
);

const listedArticleRowsCheck = Schema.Compile(
  Type.Array(
    Type.Object(
      {
        author: Type.String(),
        id: Type.Integer(),
        publishedAt: dateType,
        read: Type.Boolean(),
        revision: Type.Union([Type.String(), Type.Null()]),
        sourceId: Type.Integer(),
        title: Type.String(),
        url: Type.String(),
      },
      { additionalProperties: false },
    ),
  ),
);

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
          sanitizedVersion: articles.sanitizedVersion,
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

    if (
      !options.query &&
      (options.allSubscribed ||
        options.folderId !== undefined ||
        sourceIds.length > 1)
    ) {
      const scopeFilter = options.allSubscribed
        ? sql`TRUE`
        : options.folderId === undefined
          ? inArray(userSources.sourceId, sourceIds)
          : eq(userSources.parentId, options.folderId);
      const snoozeFilter =
        filter === "unread"
          ? sql`AND (${userSources.pausedUntil} IS NULL OR ${userSources.pausedUntil} <= NOW())`
          : sql``;
      const windowFilter = options.publishedWithinHours
        ? sql`AND ${articles.publishedAt} >= NOW() - (${options.publishedWithinHours} * INTERVAL '1 hour')`
        : sql``;
      const cursorCte = cursor
        ? sql`"cursor_row" AS (
            SELECT ${articles.publishedAt} AS "published_at", ${articles.id} AS "id"
            FROM ${articles}
            WHERE ${articles.id} = ${cursor}
          ),`
        : sql``;
      const cursorJoin = cursor ? sql`CROSS JOIN "cursor_row"` : sql``;
      const cursorFilter = cursor
        ? sql`AND (${articles.publishedAt}, ${articles.id}) < ("cursor_row"."published_at", "cursor_row"."id")`
        : sql``;
      const rows: unknown = await this.drizzleConnection.execute(sql`
        WITH ${cursorCte}
        "page" AS (
          SELECT "sub"."id", "sub"."published_at", "sub"."read"
          FROM ${userSources}
          ${cursorJoin}
          CROSS JOIN LATERAL (
            SELECT ${articles.id} AS "id",
              ${articles.publishedAt} AS "published_at",
              (${readCondition(readStateColumns)}) AS "read"
            FROM ${articles}
            LEFT JOIN ${userArticles}
              ON ${userArticles.userId} = ${userSources.userId}
              AND ${userArticles.sourceId} = ${articles.sourceId}
              AND ${userArticles.guid} = ${articles.guid}
            WHERE ${articles.sourceId} = ${userSources.sourceId}
              AND ${subscriptionSeesArticle(articles.lastSeenInFeedAt, userSources.createdAt)}
              ${windowFilter}
              AND ${articleFilterCondition(filter, readStateColumns)}
              ${cursorFilter}
            ORDER BY ${articles.publishedAt} DESC, ${articles.id} DESC
            LIMIT ${articlePageSize}
          ) "sub"
          WHERE ${userSources.userId} = ${userId}
            AND ${scopeFilter}
            ${snoozeFilter}
          ORDER BY "sub"."published_at" DESC, "sub"."id" DESC
          LIMIT ${articlePageSize}
        )
        SELECT ${articles.author} AS "author",
          ${articles.id}::double precision AS "id",
          ${articles.publishedAt} AS "publishedAt",
          "page"."read" AS "read",
          ${articles.updatedAt}::text AS "revision",
          ${articles.sourceId} AS "sourceId",
          ${articles.title} AS "title",
          ${articles.url} AS "url"
        FROM "page"
        INNER JOIN ${articles} ON ${articles.id} = "page"."id"
        ORDER BY "page"."published_at" DESC, "page"."id" DESC
      `);
      if (!listedArticleRowsCheck.Check(rows)) {
        throw new Error("Database returned an invalid article row");
      }
      return rows;
    }

    const page = this.drizzleConnection
      .select({
        id: articles.id,
        publishedAt: articles.publishedAt,
        read: sql<boolean>`${readCondition(readStateColumns)}`.as("read"),
      })
      .from(articles)
      .innerJoin(userSources, userArticleAccessJoin(userId))
      .leftJoin(userArticles, userArticleStateJoin(userId))
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
            author: sql`
              CASE
                WHEN excluded.author IS DISTINCT FROM ${articles.author} THEN excluded.author
                ELSE ${articles.author}
              END
            `,
            content: sql`
              CASE
                WHEN excluded.content IS DISTINCT FROM ${articles.content} THEN excluded.content
                ELSE ${articles.content}
              END
            `,
            enclosures: sql`excluded.enclosures`,
            lastSeenInFeedAt: sql`excluded.last_seen_in_feed_at`,
            publishedAt: sql`
              CASE
                WHEN excluded.updated_at IS NOT NULL THEN excluded.published_at
                ELSE ${articles.publishedAt}
              END
            `,
            sanitizedVersion: sql`
              CASE
                WHEN excluded.content IS DISTINCT FROM ${articles.content} THEN excluded.sanitized_version
                ELSE GREATEST(${articles.sanitizedVersion}, excluded.sanitized_version)
              END
            `,
            title: sql`
              CASE
                WHEN excluded.title IS DISTINCT FROM ${articles.title} THEN excluded.title
                ELSE ${articles.title}
              END
            `,
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
            url: sql`
              CASE
                WHEN excluded.url IS DISTINCT FROM ${articles.url} THEN excluded.url
                ELSE ${articles.url}
              END
            `,
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

    const markColumn =
      "deletedAt" in mark ? sql.raw('"deleted_at"') : sql.raw('"read_at"');
    const markValue = "deletedAt" in mark ? mark.deletedAt : mark.readAt;
    const rows: unknown = await this.drizzleConnection.execute(sql`
      WITH "authorized" AS (
        SELECT DISTINCT ${articles.id} AS "id",
          ${articles.sourceId} AS "source_id",
          ${articles.guid} AS "guid"
        FROM ${articles}
        INNER JOIN ${userSources}
          ON ${userArticleAccessJoin(userId)}
        WHERE ${inArray(articles.id, articleIdList)}
      ),
      "upserted" AS (
        INSERT INTO ${userArticles} ("user_id", "source_id", "guid", ${markColumn})
        SELECT ${userId}, "source_id", "guid", ${markValue}::timestamptz
        FROM "authorized"
        ON CONFLICT ("user_id", "source_id", "guid")
        DO UPDATE SET ${markColumn} = EXCLUDED.${markColumn}
      )
      SELECT "id"::double precision AS "id", "source_id" AS "sourceId"
      FROM "authorized"
    `);
    if (!markedArticleRowsCheck.Check(rows)) {
      throw new Error("Database returned an invalid marked article row");
    }
    return {
      articleIds: rows.map((row) => row.id),
      sourceIds: [...new Set(rows.map((row) => row.sourceId))],
    };
  }
}

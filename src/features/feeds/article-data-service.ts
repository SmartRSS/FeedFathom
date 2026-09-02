import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import {
  generateBoundaryDates,
  getDateGroup,
} from "#shared/util/get-date-group.ts";
import { userSources } from "#platform/db/schema.ts";
import type * as schema from "#platform/db/schema.ts";
import {
  type Article,
  type ArticleInsert,
  articles,
} from "#platform/db/schemas/articles.ts";
import { userArticles } from "#platform/db/schemas/user-articles.ts";

// user_articles is keyed on the article's (source, guid) rather than its id,
// so a removal survives the article row being pruned -- see the schema.
function userArticleStateJoin(userId: number) {
  return and(
    eq(userArticles.userId, userId),
    eq(userArticles.sourceId, articles.sourceId),
    eq(userArticles.guid, articles.guid),
  );
}

function userArticleAccessJoin(userId: number) {
  return and(
    eq(userSources.userId, userId),
    eq(userSources.sourceId, articles.sourceId),
    gte(articles.lastSeenInFeedAt, userSources.createdAt),
  );
}

export class ArticlesDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

  public async getUserArticle(
    articleId: number,
    userId: number,
  ): Promise<Article | undefined> {
    return (
      await this.drizzleConnection
        .select({ article: articles })
        .from(articles)
        .innerJoin(userSources, userArticleAccessJoin(userId))
        .where(eq(articles.id, articleId))
        .limit(1)
    ).at(0)?.article;
  }

  public async getUserArticlesForSources(sourceIds: number[], userId: number) {
    if (sourceIds.length === 0) {
      return [];
    }

    const loadedArticles = await this.drizzleConnection
      .select({
        author: articles.author,
        id: articles.id,
        publishedAt: articles.publishedAt,
        sourceId: articles.sourceId,
        title: articles.title,
        url: articles.url,
      })
      .from(articles)
      .leftJoin(userArticles, userArticleStateJoin(userId))
      .leftJoin(userSources, userArticleAccessJoin(userId))
      .where(
        and(
          inArray(articles.sourceId, sourceIds),
          // A removal is terminal -- deleted_at alone hides the article,
          // exactly as recomputeUnreadCounts scores it. It used to be
          // hidden only as a side effect of updated_at > read_at being
          // NULL for rows nothing writes read_at into any more; a row
          // still carrying a legacy read_at older than the article's
          // updated_at (the publisher edited it after that stamp) came
          // back into the list while the unread count still said zero.
          or(
            isNull(userArticles.userId),
            and(
              isNull(userArticles.deletedAt),
              gt(articles.updatedAt, userArticles.readAt),
            ),
          ),
          // Ensure the userSources join matched (article appeared after subscription)
          sql`${userSources.createdAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(articles.publishedAt));

    const boundaryDates = generateBoundaryDates();
    return loadedArticles.map((item) =>
      Object.assign(
        { group: getDateGroup(boundaryDates, item.publishedAt) },
        item,
      ),
    );
  }

  public async batchUpsertArticles(articlePayloads: ArticleInsert[]) {
    if (articlePayloads.length === 0) {
      return;
    }

    // A feed can list the same (sourceId, guid) twice in one fetch (republishing,
    // pagination overlap, feed-generator bugs). Postgres rejects an ON CONFLICT
    // DO UPDATE batch that targets the same row twice, so dedupe first, keeping
    // the last occurrence as the freshest data.
    const deduped = [
      ...new Map(
        articlePayloads.map((payload) => [
          `${payload.sourceId} ${payload.guid}`,
          payload,
        ]),
      ).values(),
    ];

    // Process articles in batches to avoid hitting database parameter limits
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
    const BATCH_SIZE = 10;
    const batches = [];

    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      batches.push(deduped.slice(i, i + BATCH_SIZE));
    }

    for (const [batchIndex, batch] of batches.entries()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Sequential batches bound database pressure.
        await this.drizzleConnection
          .insert(articles)
          .values(batch)
          .onConflictDoUpdate({
            set: {
              author: sql`excluded.author`,
              content: sql`excluded.content`,
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
            `,
            target: [articles.sourceId, articles.guid],
          });
      } catch (error) {
        console.error(
          `Error upserting articles batch ${batchIndex + 1}/${batches.length}:`,
          error,
        );
        console.error(
          `Batch size: ${batch.length}, Total articles: ${articlePayloads.length}`,
        );
        throw error;
      }
    }
  }

  public async removeUserArticles(
    articleIdList: number[],
    userId: number,
  ): Promise<{ articleIds: number[]; sourceIds: number[] }> {
    if (articleIdList.length === 0) {
      return { articleIds: [], sourceIds: [] };
    }

    const now = new Date();

    return await this.drizzleConnection.transaction(async (trx) => {
      // Only allow soft-deleting articles whose source the user is actually
      // subscribed to; article IDs are a guessable serial PK so we can't
      // trust the caller-supplied list as-is.
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

      const articleIds = authorizedArticles.map((row) => row.id);
      const values = authorizedArticles.map((row) => {
        return {
          deletedAt: now,
          guid: row.guid,
          sourceId: row.sourceId,
          userId,
        };
      });

      await trx
        .insert(userArticles)
        .values(values)
        .onConflictDoUpdate({
          set: { deletedAt: now },
          target: [
            userArticles.userId,
            userArticles.sourceId,
            userArticles.guid,
          ],
        });

      const sourceIds = [
        ...new Set(authorizedArticles.map((row) => row.sourceId)),
      ];
      return { articleIds, sourceIds };
    });
  }
}

import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { getBoundaryDates, getDateGroup } from "../../util/get-date-group";
import { logError } from "../../util/log";
import { userSources } from "../schema";
import {
  type Article,
  type ArticleInsert,
  articles,
} from "../schemas/articles";
import { userArticles } from "../schemas/userArticles";
import { users } from "../schemas/users";

export class ArticlesDataService {
  constructor(private readonly drizzleConnection: BunSQLDatabase) {}

  public async getArticleByGuid(guid: string): Promise<Article | undefined> {
    return (
      await this.drizzleConnection
        .select()
        .from(articles)
        .where(eq(articles.guid, guid))
        .limit(1)
    ).at(0);
  }

  public async getArticle(articleId: number): Promise<Article | undefined> {
    return (
      await this.drizzleConnection
        .select()
        .from(articles)
        .where(eq(articles.id, articleId))
        .limit(1)
    ).at(0);
  }

  public async getUserArticlesForSources(sourceIds: number[], userId: number) {
    if (sourceIds.length === 0) {
      return [];
    }

    const user = (
      await this.drizzleConnection
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    ).at(0);

    if (!user) {
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
      .leftJoin(
        userArticles,
        and(
          eq(articles.id, userArticles.articleId),
          eq(userArticles.userId, userId),
        ),
      )
      .leftJoin(
        userSources,
        and(
          eq(userSources.userId, userId),
          eq(userSources.sourceId, articles.sourceId),
          gt(articles.lastSeenInFeedAt, userSources.createdAt),
        ),
      )
      .where(
        and(
          inArray(articles.sourceId, sourceIds),
          // Remove user.createdAt filter since userSources.createdAt is more restrictive
          or(
            isNull(userArticles.articleId),
            gt(articles.updatedAt, userArticles.readAt),
          ),
          // Ensure the userSources join matched (article appeared after subscription)
          sql`${userSources.createdAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(articles.publishedAt));

    const boundaryDates = getBoundaryDates();
    return loadedArticles.map((item) => {
      return {
        group: getDateGroup(boundaryDates, item.publishedAt),
        ...item,
      };
    });
  }

  public async batchUpsertArticles(articlePayloads: ArticleInsert[]) {
    if (articlePayloads.length === 0) {
      return;
    }

    try {
      await this.drizzleConnection
        .insert(articles)
        .values(articlePayloads)
        .onConflictDoUpdate({
          target: articles.guid,
          set: {
            title: sql`excluded.title`,
            content: sql`excluded.content`,
            updatedAt: sql`excluded.updated_at`,
            lastSeenInFeedAt: sql`excluded.last_seen_in_feed_at`,
          },
        });
    } catch (error) {
      logError("Error upserting articles:", error);
      throw error;
    }
  }

  public async removeUserArticles(articleIdList: number[], userId: number) {
    const now = new Date();
    const values = articleIdList.map((articleId) => {
      return {
        articleId,
        deletedAt: now,
        userId,
      };
    });

    await this.drizzleConnection.transaction(async (trx) => {
      await trx
        .insert(userArticles)
        .values(values)
        .onConflictDoUpdate({
          set: { deletedAt: now },
          target: [userArticles.userId, userArticles.articleId],
        });
    });
  }
}

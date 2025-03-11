import { articles, userArticles } from "$lib/schema";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { Article } from "../../types/article-type.ts";
import { getBoundaryDates, getDateGroup } from "../../util/get-date-group.ts";
import { logError } from "../../util/log.ts";

export class ArticlesRepository {
  public constructor(private readonly drizzleConnection: BunSQLDatabase) {}

  public async batchUpsertArticles(
    payloads: Array<{
      author: string;
      content: string;
      guid: string;
      publishedAt: Date;
      sourceId: number;
      title: string;
      updatedAt: Date;
      url: string;
    }>,
  ) {
    if (payloads.length === 0) {
      return;
    }

    try {
      await this.drizzleConnection
        .insert(articles)
        .values(payloads)
        .onConflictDoUpdate({
          set: {
            content: sql`excluded.content`,
            title: sql`excluded.title`,
            updatedAt: sql`excluded.updated_at`,
          },
          target: articles.guid,
        });
    } catch (error) {
      logError("Error upserting articles:", error);
      throw error;
    }
  }

  public async getArticle(articleId: number): Promise<Article | undefined> {
    const article = (
      await this.drizzleConnection
        .select()
        .from(articles)
        .where(eq(articles.id, articleId))
    ).at(0);

    return article;
  }

  async getArticleByGuid(guid: string): Promise<Article | undefined> {
    const result = await this.drizzleConnection
      .select()
      .from(articles)
      .where(eq(articles.guid, guid));
    return result[0];
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
      .leftJoin(
        userArticles,
        and(
          eq(articles.id, userArticles.articleId),
          eq(userArticles.userId, userId),
        ),
      )
      .where(
        and(
          inArray(articles.sourceId, sourceIds),
          or(
            isNull(userArticles.articleId),
            gt(articles.updatedAt, userArticles.readAt),
          ),
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

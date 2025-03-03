import * as schema from "$lib/schema";
import { type Article } from "../../types/article-type";
import { getBoundaryDates, getDateGroup } from "../../util/get-date-group";
import { logError } from "../../util/log";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { type BunSQLDatabase } from "drizzle-orm/bun-sql";

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
        .insert(schema.articles)
        .values(payloads)
        .onConflictDoUpdate({
          set: {
            content: sql`excluded.content`,
            title: sql`excluded.title`,
            updatedAt: sql`excluded.updated_at`,
          },
          target: schema.articles.guid,
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
        .from(schema.articles)
        .where(eq(schema.articles.id, articleId))
    ).at(0);

    return article;
  }

  async getArticleByGuid(guid: string): Promise<Article | undefined> {
    const result = await this.drizzleConnection
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.guid, guid));
    return result[0];
  }

  public async getUserArticlesForSources(sourceIds: number[], userId: number) {
    if (!sourceIds.length) {
      return [];
    }

    const articles = await this.drizzleConnection
      .select({
        author: schema.articles.author,
        id: schema.articles.id,
        publishedAt: schema.articles.publishedAt,
        sourceId: schema.articles.sourceId,
        title: schema.articles.title,
        url: schema.articles.url,
      })
      .from(schema.articles)
      .leftJoin(
        schema.userArticles,
        and(
          eq(schema.articles.id, schema.userArticles.articleId),
          eq(schema.userArticles.userId, userId),
        ),
      )
      .where(
        and(
          inArray(schema.articles.sourceId, sourceIds),
          or(
            isNull(schema.userArticles.articleId),
            gt(schema.articles.updatedAt, schema.userArticles.readAt),
          ),
        ),
      )
      .orderBy(desc(schema.articles.publishedAt));

    const boundaryDates = getBoundaryDates();
    return articles.map((item) => {
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
        .insert(schema.userArticles)
        .values(values)
        .onConflictDoUpdate({
          set: { deletedAt: now },
          target: [schema.userArticles.userId, schema.userArticles.articleId],
        });
    });
  }
}

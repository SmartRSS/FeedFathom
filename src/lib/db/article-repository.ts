import * as schema from "$lib/schema";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Article } from "../../types/article.type";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { getBoundaryDates, getDateGroup } from "../../util/get-date-group";

export class ArticleRepository {
  public constructor(private readonly drizzleConnection: BunSQLDatabase) {}

  public async removeUserArticles(articleIdList: number[], userId: number) {
    const now = new Date();
    const values = articleIdList.map((articleId) => ({
      userId,
      articleId,
      deletedAt: now,
    }));

    await this.drizzleConnection.transaction(async (trx) => {
      await trx
        .insert(schema.userArticles)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.userArticles.userId, schema.userArticles.articleId],
          set: { deletedAt: now },
        });
    });
  }

  public async getArticle(articleId: number): Promise<Article | undefined> {
    const article = (
      await this.drizzleConnection
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, articleId))
    ).at(0);

    if (!article) {
      return;
    }
    return article;
  }

  public async getUserArticlesForSources(sourceIds: number[], userId: number) {
    if (!sourceIds.length) {
      return [];
    }

    const startTime = new Date().valueOf();
    const articles = await this.drizzleConnection
      .select({
        id: schema.articles.id,
        sourceId: schema.articles.sourceId,
        title: schema.articles.title,
        author: schema.articles.author,
        url: schema.articles.url,
        publishedAt: schema.articles.publishedAt,
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
    console.log("query time", new Date().valueOf() - startTime);

    const boundaryDates = getBoundaryDates();
    return articles.map((item) => ({
      group: getDateGroup(boundaryDates, item.publishedAt),
      ...item,
    }));
  }

  public async batchUpsertArticles(
    payloads: {
      content: string;
      guid: string;
      sourceId: number;
      title: string;
      url: string;
      author: string;
      publishedAt: Date;
      updatedAt: Date;
    }[],
  ) {
    if (payloads.length === 0) {
      return;
    }

    await this.drizzleConnection
      .insert(schema.articles)
      .values(payloads)
      .onConflictDoUpdate({
        target: schema.articles.guid,
        set: {
          updatedAt: sql`excluded.updated_at`,
          title: sql`excluded.title`,
          content: sql`excluded.content`,
        },
      });
    payloads.length = 0;
  }

  async getArticleByGuid(guid: string): Promise<Article | undefined> {
    const result = await this.drizzleConnection
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.guid, guid));
    return result[0];
  }
}

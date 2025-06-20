import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { getBoundaryDates, getDateGroup } from "../../../util/get-date-group";
import { type ArticleInsert, articles } from "../schemas/articles";
import { userArticles } from "../schemas/userArticles";

export class ArticlesDataService {
  constructor(private readonly drizzleConnection: BunSQLDatabase) {}

  public async getArticleByGuid(guid: string) {
    return (
      await this.drizzleConnection
        .select()
        .from(articles)
        .where(eq(articles.guid, guid))
        .limit(1)
    ).at(0);
  }

  public async getArticle(articleId: number) {
    return (
      await this.drizzleConnection
        .select()
        .from(articles)
        .where(eq(articles.id, articleId))
        .limit(1)
    ).at(0);
  }

  public async getUserArticlesForSources(userId: number, sourceIds: number[]) {
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

  public async batchUpsertArticles(articlePayloads: ArticleInsert[]) {
    const articlesToInsert = articlePayloads.map((article) => ({
      guid: article.guid,
      sourceId: article.sourceId,
      title: article.title,
      url: article.url,
      author: article.author,
      publishedAt: article.publishedAt ?? new Date(),
      content: article.content ?? "",
      updatedAt: article.updatedAt ?? new Date(),
    }));

    return await this.drizzleConnection
      .insert(articles)
      .values(articlesToInsert)
      .onConflictDoUpdate({
        target: articles.guid,
        set: {
          title: sql`excluded.title`,
          content: sql`excluded.content`,
          author: sql`excluded.author`,
          publishedAt: sql`excluded.publishedAt`,
          updatedAt: sql`excluded.updatedAt`,
        },
      })
      .returning();
  }

  public async removeUserArticles(userId: number, articleIds: number[]) {
    return await this.drizzleConnection
      .delete(userArticles)
      .where(
        and(
          eq(userArticles.userId, userId),
          inArray(userArticles.articleId, articleIds),
        ),
      )
      .execute();
  }
}

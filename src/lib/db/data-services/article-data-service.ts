import { and, eq, inArray, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
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
    return await this.drizzleConnection
      .select()
      .from(userArticles)
      .where(
        and(
          eq(userArticles.userId, userId),
          inArray(userArticles.articleId, sourceIds),
        ),
      );
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

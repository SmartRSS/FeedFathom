import * as schema from "$lib/schema";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Article } from "../../types/article.type";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export class ArticleRepository {
  private boundaryMemory:
    | {
        [key: string]: {
          today: Date;
          oneWeekAgo: Date;
          oneMonthAgo: Date;
          twoMonthsAgo: Date;
          lastYear: Date;
        };
      }
    | undefined;

  public constructor(private readonly drizzleConnection: PostgresJsDatabase) {}

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

    return articles.map((item) => ({
      group: this.dateGroup(item.publishedAt || new Date()),
      ...item,
    }));
  }

  public async batchUpsertArticles(payloads: Omit<Article, "id">[]) {
    if (payloads.length === 0) {
      return;
    }
    const values = await Promise.all(
      payloads.map(async (payload) => ({
        content: payload.content ?? "",
        guid: payload.guid,
        sourceId: payload.sourceId,
        title: payload.title ?? "",
        url: payload.url ?? "",
        author: payload.author ?? "",
        publishedAt: payload.publishedAt!,
        updatedAt: payload.updatedAt!,
      })),
    );

    await this.drizzleConnection
      .insert(schema.articles)
      .values(values)
      .onConflictDoUpdate({
        target: schema.articles.guid,
        set: {
          updatedAt: sql`excluded.updated_at`,
          title: sql`excluded.title`,
          content: sql`excluded.content`,
        },
      });
  }

  private generateBoundaryDates() {
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(now.getDate() - 6);
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(now.getMonth() - 1);
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(now.getMonth() - 2);
    const lastYear = new Date();
    lastYear.setFullYear(now.getFullYear() - 1);
    return {
      today: midnight,
      oneWeekAgo,
      oneMonthAgo,
      twoMonthsAgo,
      lastYear,
    };
  }

  private getBoundaryDates() {
    const today = new Date().getDate();
    if (this.boundaryMemory && today in this.boundaryMemory) {
      return this.boundaryMemory[today]!;
    }

    const boundaryDates = this.generateBoundaryDates();
    this.boundaryMemory = {};
    this.boundaryMemory[today] = boundaryDates;
    return boundaryDates;
  }

  private dateGroup(pubDate: Date) {
    const boundaryDates = this.getBoundaryDates();

    if (pubDate > boundaryDates.today) {
      return "Today";
    }
    if (pubDate > boundaryDates.oneWeekAgo) {
      return "This Week";
    }
    if (pubDate > boundaryDates.oneMonthAgo) {
      return "This Month";
    }
    if (pubDate > boundaryDates.lastYear) {
      return "This Year";
    }
    return "Older";
  }

  async getArticleByGuid(guid: string): Promise<Article | undefined> {
    const result = await this.drizzleConnection
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.guid, guid));
    return result[0];
  }
}

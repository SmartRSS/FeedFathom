import type { FoldersRepository } from "$lib/db/folder-repository";
import type { SourcesRepository } from "$lib/db/source-repository";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { OpmlNode } from "../../types/opml-types.ts";
import type { TreeNode } from "../../types/source-types.ts";
import { logError as error } from "../../util/log.ts";
import { articles, sources, userArticles, userSources } from "../schema.ts";

const building = process.env["NODE_ENV"] !== "production";

export class UserSourcesRepository {
  public constructor(
    private readonly drizzleConnection: BunSQLDatabase,
    private readonly foldersRepository: FoldersRepository,
    private readonly sourcesRepository: SourcesRepository,
  ) {}

  public async addSourceToUser(
    userId: number,
    sourcePayload: {
      homeUrl: string;
      name: string;
      parentId: null | number;
      url: string;
    },
  ) {
    if (building) {
      return;
    }

    if (sourcePayload.parentId) {
      const folders = await this.foldersRepository.getUserFolders(userId);
      if (
        !folders.some((folder) => {
          return folder.id === sourcePayload.parentId;
        })
      ) {
        error("no folder", folders[0]);
        return;
      }
    }

    const source = await this.sourcesRepository.findOrCreateSourceByUrl(
      sourcePayload.url,
      {
        // biome-ignore lint/style/useNamingConvention: <explanation>
        home_url: sourcePayload.homeUrl,
      },
    );

    if (!source) {
      throw new Error("Failed to create or find source");
    }

    const userSource = (
      await this.drizzleConnection
        .insert(userSources)
        .values({
          name: sourcePayload.name,
          parentId: sourcePayload.parentId,
          sourceId: source.id,
          userId,
        })
        .onConflictDoNothing({
          target: [userSources.sourceId, userSources.userId],
        })
        .returning()
    ).at(0);

    if (!userSource) {
      throw new Error("no user source");
    }
  }

  public async cleanup() {
    try {
      // Step 1: Clean up orphaned userArticles that belong to a user not subscribing their source anymore
      const subscribedSourceIds = this.drizzleConnection
        .select({ sourceId: userSources.sourceId })
        .from(userSources);

      // Query to find all articles whose sourceIds are not in the subscribed sourceIds
      const orphanedArticleIds = this.drizzleConnection
        .select({ id: articles.id })
        .from(articles)
        .where(notInArray(articles.sourceId, subscribedSourceIds));

      // Delete userArticles where articleId is in the orphaned articles list
      await this.drizzleConnection
        .delete(userArticles)
        .where(inArray(userArticles.articleId, orphanedArticleIds))
        .execute();

      // Step 2: Clean up orphaned sources that nobody subscribes to anymore
      await this.drizzleConnection
        .delete(sources)
        .where(
          notInArray(
            sources.id,
            this.drizzleConnection
              .selectDistinct({ id: userSources.sourceId })
              .from(userSources),
          ),
        );

      // Step 3: Clean up orphaned articles that have no source now
      await this.drizzleConnection
        .delete(articles)
        .where(
          notInArray(
            articles.sourceId,
            this.drizzleConnection.select({ id: sources.id }).from(sources),
          ),
        );

      // Step 4: Clean up orphaned userArticles without corresponding articles
      await this.drizzleConnection
        .delete(userArticles)
        .where(
          notInArray(
            userArticles.articleId,
            this.drizzleConnection.select({ id: articles.id }).from(articles),
          ),
        );
    } catch (error_) {
      error("cleanup", error_);
    }
  }

  public async getUserSources(userId: number) {
    return await this.drizzleConnection
      .select({
        favicon: sources.favicon,
        homeUrl: sources.homeUrl,
        id: sources.id,
        name: userSources.name,
        parentId: userSources.parentId,
        unreadArticlesCount: sql<number>`(
          coalesce(count(articles.id), 0) -
          coalesce(count(CASE
            WHEN user_articles.deleted_at IS NOT NULL
            OR user_articles.read_at >= articles.updated_at
            THEN 1
          END), 0)
        )::int`,
        url: sources.url,
      })
      .from(userSources)
      .where(eq(userSources.userId, userId))
      .leftJoin(sources, eq(sources.id, userSources.sourceId))
      .leftJoin(articles, eq(articles.sourceId, sources.id))
      .leftJoin(
        userArticles,
        and(
          eq(userArticles.userId, userId),
          eq(userArticles.articleId, articles.id),
        ),
      )
      .groupBy(
        sources.id,
        userSources.name,
        userSources.parentId,
        sources.favicon,
        sources.url,
        sources.homeUrl,
      )
      .orderBy(userSources.name);
  }

  public async insertTree(
    userId: number,
    tree: OpmlNode[] | TreeNode[],
    parentId?: number,
  ) {
    for (const node of tree) {
      if (node.type === "folder") {
        const folder = await this.foldersRepository.createFolder(
          userId,
          node.name,
        );
        if ("children" in node) {
          await this.insertTree(userId, node.children, folder.id);
        }
      }

      if (node.type === "source") {
        await this.addSourceToUser(userId, {
          homeUrl: node.homeUrl,
          name: node.name,
          parentId: parentId ?? null,
          url: node.xmlUrl,
        });
      }
    }
  }

  public async removeSourceFromUser(userId: number, sourceId: number) {
    await this.drizzleConnection
      .delete(userSources)
      .where(
        and(eq(userSources.userId, userId), eq(userSources.sourceId, sourceId)),
      );
  }
}

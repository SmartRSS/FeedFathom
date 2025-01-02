import * as schema from "$lib/schema";
import {
  and,
  eq,
  inArray,
  isNotNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { TreeNode } from "../../types/source-types";

import type { OpmlNode } from "../../types/opml-types";
import { err, llog } from "../../util/log";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { FolderRepository } from "$lib/db/folder-repository";
import type { SourcesRepository } from "$lib/db/source-repository";

export class UserSourceRepository {
  public constructor(
    private readonly drizzleConnection: PostgresJsDatabase,
    private readonly foldersRepository: FolderRepository,
    private readonly sourcesRepository: SourcesRepository,
  ) {}

  public async getUserSources(userId: number) {
    return this.drizzleConnection
      .select({
        id: schema.sources.id,
        name: schema.userSources.name,
        parentId: schema.userSources.parentId,
        favicon: schema.sources.favicon, // COALESCE can be used here in SQL if supported
        url: schema.sources.url,
        homeUrl: schema.sources.homeUrl,
        unreadArticlesCount: sql<number>`(coalesce(count(articles.id), 0) - coalesce(count(user_articles.article_id), 0))::int`,
      })
      .from(schema.userSources)
      .where(eq(schema.userSources.userId, userId))
      .leftJoin(
        schema.sources,
        eq(schema.sources.id, schema.userSources.sourceId),
      )
      .leftJoin(
        schema.articles,
        eq(schema.articles.sourceId, schema.sources.id),
      )
      .leftJoin(
        schema.userArticles,
        and(
          eq(schema.userArticles.userId, userId),
          eq(schema.userArticles.articleId, schema.articles.id),
          or(
            isNotNull(schema.userArticles.deletedAt),
            lt(schema.articles.updatedAt, schema.userArticles.readAt),
          ),
        ),
      )
      .groupBy(
        schema.sources.id,
        schema.userSources.name,
        schema.userSources.parentId,
        schema.sources.favicon,
        schema.sources.url,
        schema.sources.homeUrl,
      )
      .orderBy(schema.userSources.name);
  }

  public async addSourceToUser(
    userId: number,
    sourcePayload: {
      url: string;
      homeUrl: string;
      parentId: number | null;
      name: string;
    },
  ) {
    if (sourcePayload.parentId) {
      const folders = await this.foldersRepository.getUserFolders(userId);
      if (!folders.some((folder) => folder.id === sourcePayload.parentId)) {
        err("no folder", folders[0]);
        return;
      }
    }
    const source = await this.sourcesRepository.findOrCreateSourceByUrl(
      sourcePayload.url,
      {
        home_url: sourcePayload.homeUrl,
      },
    );
    if (!source) {
      err("no source");
      return;
    }

    const userSource = (
      await this.drizzleConnection
        .insert(schema.userSources)
        .values({
          userId: userId,
          sourceId: source.id,
          name: sourcePayload.name,
          parentId: sourcePayload.parentId,
        })
        .onConflictDoNothing({
          target: [schema.userSources.sourceId, schema.userSources.userId],
        })
        .returning()
    ).at(0);

    if (!userSource) {
      return;
    }

    return userSource;
  }

  public async insertTree(
    userId: number,
    tree: TreeNode[] | OpmlNode[],
    parentId?: number,
  ) {
    for (const node of tree) {
      if (node.type === "folder") {
        const folder = await this.foldersRepository.createFolder(
          userId,
          node.name,
        );
        if ("children" in node && node.children !== undefined)
          await this.insertTree(userId, node.children, folder.id);
      }
      if (node.type === "source") {
        await this.addSourceToUser(userId, {
          url: node.xmlUrl,
          homeUrl: node.homeUrl,
          parentId: parentId ?? null,
          name: node.name,
        });
      }
    }
  }

  public async removeSourceFromUser(userId: number, sourceId: number) {
    await this.drizzleConnection
      .delete(schema.userSources)
      .where(
        and(
          eq(schema.userSources.userId, userId),
          eq(schema.userSources.sourceId, sourceId),
        ),
      );
  }

  public async cleanup() {
    llog("attempting cleanup");
    const startTime = new Date().valueOf();
    try {
      // Step 1: Clean up orphaned userArticles that belong to a user not subscribing their source anymore
      const subscribedSourceIds = this.drizzleConnection
        .select({ sourceId: schema.userSources.sourceId })
        .from(schema.userSources);

      // Query to find all articles whose sourceIds are not in the subscribed sourceIds
      const orphanedArticleIds = this.drizzleConnection
        .select({ id: schema.articles.id })
        .from(schema.articles)
        .where(notInArray(schema.articles.sourceId, subscribedSourceIds));

      // Delete userArticles where articleId is in the orphaned articles list
      await this.drizzleConnection
        .delete(schema.userArticles)
        .where(inArray(schema.userArticles.articleId, orphanedArticleIds))
        .execute();

      // Step 2: Clean up orphaned sources that nobody subscribes to anymore
      await this.drizzleConnection
        .delete(schema.sources)
        .where(
          notInArray(
            schema.sources.id,
            this.drizzleConnection
              .selectDistinct({ id: schema.userSources.sourceId })
              .from(schema.userSources),
          ),
        );

      // Step 3: Clean up orphaned articles that have no source now
      await this.drizzleConnection
        .delete(schema.articles)
        .where(
          notInArray(
            schema.articles.sourceId,
            this.drizzleConnection
              .select({ id: schema.sources.id })
              .from(schema.sources),
          ),
        );

      // Step 4: Clean up orphaned userArticles without corresponding articles
      await this.drizzleConnection
        .delete(schema.userArticles)
        .where(
          notInArray(
            schema.userArticles.articleId,
            this.drizzleConnection
              .select({ id: schema.articles.id })
              .from(schema.articles),
          ),
        );
      llog("cleanup took ", new Date().valueOf() - startTime);
    } catch (e) {
      err("cleanup", e);
    }
  }
}

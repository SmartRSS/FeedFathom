import type { ArticleInsert } from "#platform/db/schemas/articles.ts";
import type { ArticleEventPublisher } from "#features/feeds/article-events.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import {
  extractArticle,
  sanitizerVersion,
} from "#features/feeds/extract-article.ts";
import type { FetchTrigger } from "#platform/db/schemas/sources.ts";
import type { FeedArticle } from "#features/feeds/feed-mapper.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";

export class ArticleImporter {
  constructor(
    private readonly articlesDataService: Pick<
      ArticlesDataService,
      "batchUpsertArticles"
    >,
    private readonly userSourcesDataService: Pick<
      UserSourcesDataService,
      "recomputeUnreadCounts"
    >,
    private readonly articleEventPublisher: Pick<
      ArticleEventPublisher,
      "publish"
    >,
    private readonly sourcesDataService: Pick<
      SourcesDataService,
      "successSource"
    >,
  ) {}

  public async recordFetch(
    sourceId: number,
    articles: readonly FeedArticle[],
    {
      alwaysRecount = false,
      bodyHash,
      cached,
      freshUntil,
      homeUrl,
      trigger,
    }: {
      alwaysRecount?: boolean;
      bodyHash?: string | undefined;
      cached: boolean;
      freshUntil?: null | number | undefined;
      homeUrl?: string | undefined;
      trigger: FetchTrigger;
    },
  ): Promise<void> {
    const now = Date.now();
    let hasExpiringAlert = false;
    const rows: Omit<ArticleInsert, "lastSeenInFeedAt">[] = [];
    for (const article of articles) {
      if (article.expiresAt !== undefined) {
        hasExpiringAlert = true;
        if (article.expiresAt <= now) continue;
      }
      rows.push({
        author: article.author,
        content: extractArticle(article.content, article.contentBaseUrl),
        enclosures: article.enclosures,
        guid: article.guid,
        publishedAt: article.publishedAt,
        sanitizedVersion: sanitizerVersion,
        sourceId,
        title: article.title,
        updatedAt: article.updatedAt,
        url: article.url,
      });
    }
    await this.importArticles(sourceId, rows, { alwaysRecount });
    await this.sourcesDataService.successSource(sourceId, {
      ...(bodyHash === undefined
        ? {}
        : { bodyHash: hasExpiringAlert ? null : bodyHash }),
      cached,
      homeUrl,
      notBefore: freshUntil ? new Date(freshUntil) : undefined,
      trigger,
    });
  }

  private async importArticles(
    sourceId: number,
    rows: Omit<ArticleInsert, "lastSeenInFeedAt">[],
    { alwaysRecount = false }: { alwaysRecount?: boolean } = {},
  ): Promise<void> {
    let upsertError: unknown;
    let changed = 0;
    try {
      changed = await this.articlesDataService.batchUpsertArticles(rows);
    } catch (error) {
      upsertError = error;
    }
    try {
      if (alwaysRecount || upsertError !== undefined || changed > 0) {
        await this.userSourcesDataService.recomputeUnreadCounts([sourceId]);
      }
    } catch (recomputeError) {
      if (upsertError === undefined) throw recomputeError;
      console.error(
        "recomputeUnreadCounts failed after batchUpsertArticles error:",
        recomputeError,
      );
    }
    if (upsertError !== undefined) throw upsertError;
    if (changed > 0) this.articleEventPublisher.publish(sourceId, changed);
  }
}

import type { ArticleInsert } from "#platform/db/schemas/articles.ts";
import type { ArticleEventPublisher } from "#features/feeds/article-events.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
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
      cached,
      freshUntil,
      homeUrl,
      trigger,
    }: {
      alwaysRecount?: boolean;
      cached: boolean;
      freshUntil?: null | number | undefined;
      homeUrl?: string | undefined;
      trigger: FetchTrigger;
    },
  ): Promise<void> {
    const observedAt = new Date();
    const rows = articles
      .filter(
        ({ expiresAt }) =>
          expiresAt === undefined || expiresAt > observedAt.getTime(),
      )
      .map(({ expiresAt: _expiresAt, ...article }) =>
        Object.assign(article, { lastSeenInFeedAt: observedAt }),
      );
    await this.importArticles(sourceId, rows, { alwaysRecount });
    await this.sourcesDataService.successSource(sourceId, {
      cached,
      homeUrl,
      notBefore: freshUntil ? new Date(freshUntil) : undefined,
      observedAt,
      trigger,
    });
  }

  private async importArticles(
    sourceId: number,
    rows: readonly Omit<ArticleInsert, "sourceId">[],
    { alwaysRecount = false }: { alwaysRecount?: boolean } = {},
  ): Promise<void> {
    let upsertError: unknown;
    let changed = 0;
    try {
      changed = await this.articlesDataService.batchUpsertArticles(
        rows.map((row) => Object.assign({}, row, { sourceId })),
      );
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

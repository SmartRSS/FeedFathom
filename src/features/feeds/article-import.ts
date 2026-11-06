import type { ArticleInsert } from "#platform/db/schemas/articles.ts";
import type { ArticleEventPublisher } from "#features/feeds/article-events.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import type { FetchTrigger } from "#platform/db/schemas/sources.ts";
import type { FeedArticle } from "#features/feeds/feed-mapper.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";

/** The one way articles land in the store: upsert, recount, announce. */
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

  /**
   * Records one successful fetch of a feed: stores the articles it listed,
   * then the source's success. Both carry one timestamp, which the retention
   * rules rely on: an article whose last_seen_in_feed_at is older than the
   * source's last_success was not in that fetch. A CAP alert that has expired
   * by now is left out, which matters for a fetch replayed from a stored
   * preview.
   */
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
      // When the response stops being fresh, which is the earliest the feed
      // is worth fetching again.
      freshUntil?: null | number | undefined;
      // The site the feed says it belongs to, if it names one.
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

  /**
   * Stores one source's articles. batchUpsertArticles commits batch by batch, so a later
   * failure leaves earlier articles committed: the badges are recounted
   * either way, then the upsert error is re-raised. Otherwise they are
   * recounted only when a row changed: most polls change nothing, and the
   * recount aggregates every retained article against every subscriber
   * (#897). `alwaysRecount` is for one-off imports (subscribe, mail), whose
   * retry after a crash between upsert and recount changes no row yet still
   * has a badge to fix.
   */
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
      // The upsert failure is the root cause; don't let this replace it.
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

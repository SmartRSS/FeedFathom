import type { ArticleInsert } from "#platform/db/schemas/articles.ts";
import type { ArticleEventPublisher } from "#features/feeds/article-events.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
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
  ) {}

  /**
   * Stores one source's articles and returns how many a badge could count
   * differently. batchUpsertArticles commits batch by batch, so a later
   * failure leaves earlier articles committed: the badges are recounted
   * either way, then the upsert error is re-raised. Otherwise they are
   * recounted only when a row changed: most polls change nothing, and the
   * recount aggregates every retained article against every subscriber
   * (#897).
   */
  public async importArticles(
    sourceId: number,
    rows: readonly Omit<ArticleInsert, "sourceId">[],
  ): Promise<number> {
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
      if (upsertError !== undefined || changed > 0) {
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
    return changed;
  }
}

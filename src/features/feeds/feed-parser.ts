import type {
  FetchTrigger,
  WebSubStatus,
} from "#platform/db/schemas/sources.ts";
import { type HttpClient } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { HttpDeadlineError } from "#platform/http/request-deadline.ts";
import type { RedirectMap } from "#features/feeds/redirect-map.ts";
import { parseFeedDocument } from "#features/feeds/feed-document.ts";
import {
  feedHomeUrl,
  mapFeedToArticles,
  mapFeedToPreview,
} from "#features/feeds/feed-mapper.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { discoverWebSub } from "#features/feeds/websub.ts";
import type { WebSubSubscriber } from "#features/feeds/websub-subscriber.ts";
import type { ArticleImporter } from "#features/feeds/article-import.ts";

export class FeedParser {
  constructor(
    private readonly articleImporter: Pick<ArticleImporter, "recordFetch">,
    private readonly httpClient: HttpClient,
    private readonly sourcesDataService: Pick<
      SourcesDataService,
      "failSource" | "updateSourceUrl"
    >,
    private readonly webSubSubscriber: Pick<
      WebSubSubscriber,
      "subscribe" | "wants"
    >,
    private readonly redirectMap: RedirectMap,
  ) {}

  public async parseSource(source: {
    id: number;
    skipCache?: boolean;
    subscriberCount?: number;
    trigger?: FetchTrigger;
    url: string;
    websubStatus?: WebSubStatus;
  }) {
    try {
      const { cached, feed, finalUrl, freshUntil, websub } =
        await this.parseUrl(source.url, {
          priority: "background",
          skipCache: source.skipCache,
          subscribers: source.subscriberCount,
          websub: this.webSubSubscriber.wants(source.websubStatus),
        });

      if (websub) await this.webSubSubscriber.subscribe(source.id, websub);

      await this.articleImporter.recordFetch(
        source.id,
        mapFeedToArticles(feed, source.url, { baseUrl: finalUrl }),
        {
          cached,
          freshUntil,
          homeUrl: feedHomeUrl(feed, finalUrl),
          trigger: source.trigger ?? "poll",
        },
      );
    } catch (error_: unknown) {
      if (error_ instanceof HttpDeferredError) {
        throw error_;
      }
      console.error(`parseSource failed for ${source.url}`, error_);

      const message = error_ instanceof Error ? error_.message : String(error_);
      await this.sourcesDataService.failSource(source.id, message);
    }
  }

  // Called from the subscribe route so discovery happens while adding the
  // source; otherwise a WebSub-capable feed sits on ordinary polling until
  // some later parseSource run.
  public async discoverAndSubscribeWebSub(
    sourceId: number,
    url: string,
    websubStatus?: WebSubStatus,
  ): Promise<void> {
    if (!this.webSubSubscriber.wants(websubStatus)) return;
    try {
      const { websub } = await this.parseUrl(url);
      if (websub) await this.webSubSubscriber.subscribe(sourceId, websub);
    } catch (error) {
      // The article-fetch path running alongside this (cached-preview upsert
      // or the enqueued parseSource job) already reports fetch/parse failures.
      console.error(
        `WebSub discovery fetch failed for source ${sourceId}:`,
        error,
      );
    }
  }

  // A failure comes back as the fetcher's reason, for the route to phrase.
  public async preview(
    sourceUrl: string,
  ): Promise<ReturnType<typeof mapFeedToPreview> | { failure: string }> {
    try {
      const { feed, finalUrl, freshUntil } = await this.parseUrl(sourceUrl, {
        websub: false,
      });
      return Object.assign(
        mapFeedToPreview(feed, sourceUrl, { baseUrl: finalUrl }),
        { freshUntil },
      );
    } catch (error_: unknown) {
      // A deferral and our own expired deadline both mean "we never got an
      // answer", which the error hook maps to a 429 and a 504. Collapsing
      // them into undefined would report our timeout as the user's bad URL.
      if (
        error_ instanceof HttpDeferredError ||
        error_ instanceof HttpDeadlineError
      ) {
        throw error_;
      }
      return { failure: error_ instanceof Error ? error_.message : "" };
    }
  }

  public async parseUrl(
    originalUrl: string,
    {
      priority = "interactive",
      skipCache = false,
      subscribers,
      websub = true,
    }: {
      priority?: "background" | "interactive";
      skipCache?: boolean | undefined;
      // Left undefined by discovery and preview callers -- see buildUserAgent.
      subscribers?: number | undefined;
      // Whether to look for a WebSub hub; a preview never needs one.
      websub?: boolean;
    } = {},
  ) {
    const fetchedUrl = await this.redirectMap.resolveUrl(originalUrl);
    const response = await this.httpClient.get(fetchedUrl, {
      priority,
      responseType: "arrayBuffer",
      skipCache,
      ...(subscribers === undefined ? {} : { subscribers }),
    });
    if (response.status !== 200) {
      throw new Error(
        `Failed to load data for ${fetchedUrl}, received status ${response.status.toString()}`,
      );
    }
    const finalUrl = response.url;
    // 301/308 are permanent, so persist onto the subscribed source's URL;
    // 302/303/307 belong only in the short-lived Redis redirect cache.
    const rememberRedirect = response.redirectedPermanently
      ? (from: string, to: string) =>
          this.sourcesDataService.updateSourceUrl(from, to)
      : // The cache only saves a hop on the next fetch; failing to write it
        // must not cost this fetch's articles.
        (from: string, to: string) =>
          this.redirectMap.setRedirect(from, to).catch((error: unknown) => {
            console.error(`Could not cache redirect ${from} -> ${to}:`, error);
          });
    // Only remember original -> final when this fetch actually redirected.
    // fetchedUrl is already pre-substituted from the cache, so refreshing on a
    // non-redirect would rewrite a stale mapping forever once the origin's
    // transient redirect reverted. Left alone, it expires on its TTL.
    if (finalUrl !== fetchedUrl) {
      await rememberRedirect(fetchedUrl, finalUrl);
      if (originalUrl !== fetchedUrl) {
        await rememberRedirect(originalUrl, finalUrl);
      }
    }
    const { feed, text, websubHubUrl } = parseFeedDocument(
      response.data,
      response.headers.get("content-type"),
      finalUrl,
    );
    return {
      cached: response.cached,
      feed,
      finalUrl,
      freshUntil: response.freshUntil,
      websub: websub
        ? discoverWebSub(response.headers, text, finalUrl, websubHubUrl)
        : undefined,
    };
  }
}

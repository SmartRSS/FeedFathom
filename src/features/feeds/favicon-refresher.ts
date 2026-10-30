import { type HttpClient } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { defaultIntervals } from "#platform/http/http-rate-limiter.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import {
  imageDimensions,
  isBetterFavicon,
  targetFaviconSize,
} from "#features/feeds/favicon-selection.ts";
import { normalizeFavicon } from "#features/feeds/favicon-normalization.ts";

/**
 * Fetches a site's favicon from the free providers and stores the best result.
 *
 * Separate from feed parsing: it shares a source and an HTTP client with the
 * parser and nothing else, and it answers a different question -- what does
 * this site look like, not what did it publish.
 */
export class FaviconRefresher {
  constructor(
    private readonly httpClient: HttpClient,
    private readonly sourcesDataService: Pick<
      SourcesDataService,
      "updateFavicon"
    >,
  ) {}

  private async bestFavicon(urls: string[], sourceId: number) {
    const results = await Promise.allSettled(
      urls.map((url) =>
        this.httpClient.get(url, {
          priority: "background",
          responseType: "arrayBuffer",
        }),
      ),
    );

    // A deferred provider is not a miss: it may hold the best icon, so no
    // winner is picked from the rest until every provider has answered.
    const deferrals = results.flatMap((result) =>
      result.status === "rejected" && result.reason instanceof HttpDeferredError
        ? [result.reason.retryAt]
        : [],
    );
    if (deferrals.length > 0) {
      throw new HttpDeferredError(
        Math.max(...deferrals) + retryStaggerMs(sourceId),
      );
    }

    let best: { buffer: Buffer; contentType: string; size: number } | undefined;
    for (const result of results) {
      if (result.status === "rejected") continue;

      const response = result.value;
      if (response.status !== 200) continue;

      const buffer = Buffer.from(response.data);
      if (buffer.length < 20) continue;

      const dimensions = imageDimensions(buffer);
      if (!dimensions) continue;

      const size = Math.max(dimensions.width, dimensions.height);
      if (!best || isBetterFavicon(size, best.size, targetFaviconSize)) {
        best = {
          buffer,
          contentType: response.headers.get("content-type") ?? "image/png",
          size,
        };
      }
    }

    return best;
  }

  public async refreshFavicon(source: { homeUrl: string; id: number }) {
    // Query the free providers concurrently and keep the smallest valid
    // image that still meets TARGET_FAVICON_SIZE (falling back to the
    // biggest available if none do) -- an earlier one can succeed with a
    // smaller icon while a later one has a bigger one. unavatar.io is
    // capped at 25 requests/day on the free tier, so it's only used as a
    // last resort when nothing else has an icon.
    let hostname: string;
    try {
      hostname = new URL(source.homeUrl).hostname;
    } catch {
      return;
    }
    // homeUrl is encoded: a raw `?` or `&` in it would end up in gstatic's
    // own query string. favicon.im takes a bare domain in its path, and
    // without throw-error-on-404 it answers an unknown domain with a generic
    // SVG that would outrank every real icon below 64 px.
    // A deferral from either pass throws, so unavatar is only asked once
    // every primary provider has really missed.
    const best =
      (await this.bestFavicon(
        [
          `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(source.homeUrl)}&size=${targetFaviconSize}`,
          `https://favicon.im/${hostname}?throw-error-on-404=true`,
          `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
        ],
        source.id,
      )) ??
      (await this.bestFavicon(
        [`https://unavatar.io/domain/${hostname}?size=${targetFaviconSize}`],
        source.id,
      ));
    if (!best) return;

    const favicon = await normalizeFavicon(best.buffer, best.contentType);
    await this.sourcesDataService.updateFavicon(
      source.id,
      favicon.buffer,
      favicon.contentType,
    );
  }
}

// Jobs deferred by one provider host share its retryAt; an offset taken from
// the source id, within one background interval, keeps them from all waking
// at the same instant to race for a single slot.
function retryStaggerMs(sourceId: number) {
  return (sourceId % 10) * (defaultIntervals.background / 10);
}

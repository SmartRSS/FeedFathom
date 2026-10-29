import { type HttpClient } from "#platform/http/http-client.ts";
import {
  HttpDeferredError,
  isHttpDeferredError,
} from "#platform/http/http-deferred-error.ts";
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

  private async bestFavicon(urls: string[]) {
    const results = await Promise.allSettled(
      urls.map((url) =>
        this.httpClient.get(url, {
          priority: "background",
          responseType: "arrayBuffer",
        }),
      ),
    );

    let best: { buffer: Buffer; contentType: string; size: number } | undefined;
    // Infinity until a provider defers, so two passes merge with Math.min.
    let earliestRetryAt = Infinity;
    for (const result of results) {
      if (result.status === "rejected") {
        if (isHttpDeferredError(result.reason)) {
          earliestRetryAt = Math.min(earliestRetryAt, result.reason.retryAt);
        }
        continue;
      }

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

    return { best, earliestRetryAt };
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
    // own query string. favicon.im takes a bare domain in its path.
    const primary = await this.bestFavicon([
      `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(source.homeUrl)}&size=${targetFaviconSize}`,
      `https://favicon.im/${hostname}`,
      `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
    ]);
    const result = primary.best
      ? primary
      : await this.bestFavicon([
          `https://unavatar.io/domain/${hostname}?size=${targetFaviconSize}`,
        ]);

    if (result.best) {
      const favicon = await normalizeFavicon(
        result.best.buffer,
        result.best.contentType,
      );
      await this.sourcesDataService.updateFavicon(
        source.id,
        favicon.buffer,
        favicon.contentType,
      );
      return;
    }

    // Nothing usable came back, but a rate-limited provider might have
    // something once it's no longer throttled — retry later instead of
    // treating this as a dead end.
    const retryAt = Math.min(primary.earliestRetryAt, result.earliestRetryAt);
    if (retryAt !== Infinity) throw new HttpDeferredError(retryAt);
  }
}

import { Type } from "typebox";
import Schema from "typebox/schema";
import {
  type HttpClient,
  HttpDeferredError,
  isHttpDeferredError,
} from "#platform/http/http-client.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import {
  imageDimensions,
  isBetterFavicon,
  targetFaviconSize,
} from "#features/feeds/favicon-selection.ts";

const successfulStatusCheck = Schema.Compile(Type.Literal(200));

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
    let earliestRetryAt: number | undefined;
    for (const result of results) {
      if (result.status === "rejected") {
        if (isHttpDeferredError(result.reason)) {
          earliestRetryAt = Math.min(
            earliestRetryAt ?? Infinity,
            result.reason.retryAt,
          );
        }
        continue;
      }

      const response = result.value;
      if (!successfulStatusCheck.Check(response.status)) continue;

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
    const primaryUrls = [
      `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${source.homeUrl}&size=${targetFaviconSize}`,
      `https://favicon.im/${source.homeUrl}`,
      `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
    ];

    const primary = await this.bestFavicon(primaryUrls);
    let result = primary;
    if (!primary.best) {
      const fallback = await this.bestFavicon([
        `https://unavatar.io/domain/${hostname}?size=${targetFaviconSize}`,
      ]);
      result = {
        best: fallback.best,
        earliestRetryAt:
          primary.earliestRetryAt !== undefined ||
          fallback.earliestRetryAt !== undefined
            ? Math.min(
                primary.earliestRetryAt ?? Infinity,
                fallback.earliestRetryAt ?? Infinity,
              )
            : undefined,
      };
    }

    if (result.best) {
      await this.sourcesDataService.updateFavicon(
        source.id,
        result.best.buffer,
        result.best.contentType,
      );
      return;
    }

    // Nothing usable came back, but a rate-limited provider might have
    // something once it's no longer throttled — retry later instead of
    // treating this as a dead end.
    if (result.earliestRetryAt !== undefined) {
      throw new HttpDeferredError(result.earliestRetryAt);
    }
  }
}

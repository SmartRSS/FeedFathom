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

// A refresh deferred by a provider waits at most this long past its first
// run. That rides out the pacing queue and the hour-long Retry-After that
// providers commonly send, and still lets every job finish, and free its
// jobId, long before the next daily gather. A provider deferring past it
// counts as a miss, so one that never stops answering 429 cannot hold back
// every icon.
export const faviconDeferralHorizonMs = 2 * 60 * 60_000;

// Deferred refreshes queue up behind one another, one slot per background
// interval plus slack for start jitter and the round trips of a job's own
// requests, so they wake one at a time instead of all at the same retryAt.
const slotKey = "favicon-refresh-slot";
const slotGapMs = defaultIntervals.background + 2_000;

// Returns max(ARGV[1], last slot + ARGV[2]) and records it as the last slot,
// atomically across worker instances. The key lives until that slot is a gap
// behind; after that, any retryAt wins anyway.
const reserveSlotScript = `
local slot = math.max(tonumber(ARGV[1]), (tonumber(redis.call('GET', KEYS[1])) or 0) + tonumber(ARGV[2]))
redis.call('SET', KEYS[1], string.format('%d', slot), 'PXAT', string.format('%d', slot + tonumber(ARGV[2])))
return slot`;

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
    private readonly redis: {
      send(command: "EVAL", args: string[]): Promise<unknown>;
    },
  ) {}

  // The best answer, and the latest retryAt among providers deferred inside
  // the horizon: those may still hold a better icon, so the caller defers
  // rather than settle. An answer at exactly the target size cannot be beaten
  // (isBetterFavicon), so it needs no wait.
  private async bestFavicon(urls: string[], horizon: number) {
    const results = await Promise.allSettled(
      urls.map((url) =>
        this.httpClient.get(url, {
          priority: "background",
          responseType: "arrayBuffer",
        }),
      ),
    );

    let best: { buffer: Buffer; contentType: string; size: number } | undefined;
    let retryAt: number | undefined;
    for (const result of results) {
      if (result.status === "rejected") {
        // A wait of one background interval or less is the limiter's own
        // pacing, which always clears, so only a longer block can go past
        // the horizon and count as a miss.
        const reason: unknown = result.reason;
        if (
          reason instanceof HttpDeferredError &&
          reason.retryAt <=
            Math.max(horizon, Date.now() + defaultIntervals.background)
        ) {
          retryAt = Math.max(retryAt ?? 0, reason.retryAt);
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

    if (best?.size === targetFaviconSize) retryAt = undefined;
    return { best, retryAt };
  }

  /**
   * `firstRunAt` is when this refresh first ran, carried across deferrals;
   * the horizon counts from it.
   */
  public async refreshFavicon(source: {
    firstRunAt: number;
    homeUrl: string;
    id: number;
  }) {
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
    const horizon = source.firstRunAt + faviconDeferralHorizonMs;
    // homeUrl is encoded: a raw `?` or `&` in it would end up in gstatic's
    // own query string. favicon.im takes a bare domain in its path, and
    // without throw-error-on-404 it answers an unknown domain with a generic
    // SVG that would outrank every real icon below 64 px.
    let found = await this.bestFavicon(
      [
        `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(source.homeUrl)}&size=${targetFaviconSize}`,
        `https://favicon.im/${hostname}?throw-error-on-404=true`,
        `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
      ],
      horizon,
    );
    // A primary deferred inside the horizon is not a miss, so unavatar is
    // only asked once every primary provider has really missed.
    if (!found.best && found.retryAt === undefined) {
      found = await this.bestFavicon(
        [`https://unavatar.io/domain/${hostname}?size=${targetFaviconSize}`],
        horizon,
      );
    }
    if (found.retryAt !== undefined) {
      throw new HttpDeferredError(await this.reserveSlot(found.retryAt));
    }
    if (!found.best) return;

    const favicon = await normalizeFavicon(
      found.best.buffer,
      found.best.contentType,
    );
    await this.sourcesDataService.updateFavicon(
      source.id,
      favicon.buffer,
      favicon.contentType,
    );
  }

  private async reserveSlot(retryAt: number) {
    return Number(
      await this.redis.send("EVAL", [
        reserveSlotScript,
        "1",
        slotKey,
        Math.ceil(retryAt).toString(),
        slotGapMs.toString(),
      ]),
    );
  }
}

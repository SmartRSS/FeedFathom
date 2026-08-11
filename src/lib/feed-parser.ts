import { parseFeed } from "@rowanmanning/feed-parser";
import { Type } from "typebox";
import Schema from "typebox/schema";
import type { ArticlesDataService } from "../db/data-services/article-data-service.ts";
import type { SourcesDataService } from "../db/data-services/source-data-service.ts";
import type { UserSourcesDataService } from "../db/data-services/user-source-data-service.ts";
import { mapFeedItemToArticle, mapFeedToPreview } from "./feed-mapper.ts";
import {
  type HttpClient,
  HttpDeferredError,
  isHttpDeferredError,
} from "./http-client.ts";
import type { RedirectMap } from "./redirect-map.ts";
import { rewriteLinks } from "./rewrite-links.ts";
import { dateType, webUrlPolicy } from "./typebox-policy.ts";
import { discoverWebSub, requestHubSubscription } from "./websub.ts";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const feedAuthorProjection = Type.Object(
  { name: nullableString },
  { additionalProperties: true },
);
const feedItemProjection = Type.Object(
  {
    authors: Type.Array(feedAuthorProjection),
    content: nullableString,
    description: nullableString,
    id: nullableString,
    published: Type.Union([dateType, Type.Null()]),
    title: nullableString,
    updated: Type.Union([dateType, Type.Null()]),
    url: nullableString,
  },
  { additionalProperties: true },
);
const feedProjection = Type.Object(
  {
    description: nullableString,
    items: Type.Array(feedItemProjection),
    title: nullableString,
    url: nullableString,
  },
  { additionalProperties: true },
);
const feedProjectionCheck = Schema.Compile(feedProjection);
const successfulStatusCheck = Schema.Compile(Type.Literal(200));
const feedResponseStatusProjection = Type.Object(
  { status: Type.Number() },
  { additionalProperties: true },
);
const feedResponseStatusProjectionCheck = Schema.Compile(
  feedResponseStatusProjection,
);
const successfulFeedResponse = Type.Object(
  {
    cached: Type.Boolean(),
    status: Type.Literal(200),
    url: Type.Intersect([Type.String(), webUrlPolicy]),
  },
  { additionalProperties: true },
);
const successfulFeedResponseCheck = Schema.Compile(successfulFeedResponse);

const xmlEncodingPattern = /<\?xml[^>]*\bencoding=["']([^"']+)["']/i;

// The <?xml ...?> prolog is guaranteed ASCII-compatible up to the encoding
// declaration itself, so it's always safe to decode as windows-1252 (a
// superset of ASCII with no invalid byte sequences) just to go looking for it.
export function detectFeedEncoding(
  buffer: ArrayBuffer,
  contentType: string | null,
): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";

  const charset = /charset=([^;]+)/i.exec(contentType ?? "")?.[1]?.trim();
  if (charset) return charset;

  const prolog = new TextDecoder("windows-1252").decode(bytes.subarray(0, 200));
  return xmlEncodingPattern.exec(prolog)?.[1] ?? "utf-8";
}

export function decodeFeedBody(
  buffer: ArrayBuffer,
  contentType: string | null,
): string {
  try {
    return new TextDecoder(detectFeedEncoding(buffer, contentType)).decode(
      buffer,
    );
  } catch {
    // Unrecognized/unsupported encoding label — UTF-8 is the right default
    // for the overwhelming majority of feeds anyway.
    return new TextDecoder("utf-8").decode(buffer);
  }
}

export function validateParsedFeed(value: unknown): void {
  if (!feedProjectionCheck.Check(value)) {
    throw new Error("Feed parser returned an invalid feed projection");
  }
}

// Some favicon providers return an error placeholder (e.g. an HTML 404 page,
// or HTML-entity-escaped SVG markup) with a 200 status and a plausible
// content-type. Parse actual magic bytes / markup to size the result and
// reject anything that isn't really an image.
function imageDimensions(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  if (
    buffer.length >= 24 &&
    buffer.subarray(1, 4).toString("latin1") === "PNG"
  ) {
    return { height: buffer.readUInt32BE(20), width: buffer.readUInt32BE(16) };
  }
  if (
    buffer.length >= 10 &&
    buffer.subarray(0, 3).toString("latin1") === "GIF"
  ) {
    return { height: buffer.readUInt16LE(8), width: buffer.readUInt16LE(6) };
  }
  if (
    buffer.length >= 22 &&
    buffer.readUInt16LE(0) === 0 &&
    buffer.readUInt16LE(2) === 1
  ) {
    return {
      height: buffer[7] === 0 ? 256 : buffer[7]!,
      width: buffer[6] === 0 ? 256 : buffer[6]!,
    };
  }
  if (
    buffer.length >= 26 &&
    buffer.subarray(0, 2).toString("latin1") === "BM"
  ) {
    return {
      height: Math.abs(buffer.readInt32LE(22)),
      width: buffer.readInt32LE(18),
    };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1]!;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    return undefined;
  }
  if (/^\s*<svg[\s>]/i.test(buffer.toString("utf8", 0, 500))) {
    return { height: Infinity, width: Infinity };
  }
  return undefined;
}

// Prefers the smallest candidate that still meets `target`, over always
// grabbing the biggest available -- falls back to the biggest undersized
// candidate only when nothing meets the target at all.
export function isBetterFavicon(
  candidateSize: number,
  bestSize: number,
  target: number,
): boolean {
  const candidateMeetsTarget = candidateSize >= target;
  const bestMeetsTarget = bestSize >= target;
  if (candidateMeetsTarget && bestMeetsTarget) return candidateSize < bestSize;
  if (candidateMeetsTarget) return true;
  if (bestMeetsTarget) return false;
  return candidateSize > bestSize;
}

export class FeedParser {
  constructor(
    private readonly articlesDataService: ArticlesDataService,
    private readonly httpClient: HttpClient,
    private readonly sourcesDataService: SourcesDataService,
    private readonly redirectMap: RedirectMap,
    private readonly userSourcesDataService: Pick<
      UserSourcesDataService,
      "recomputeUnreadCounts"
    >,
    // Undefined skips WebSub entirely (see maybeSubscribeToWebSub) -- there's
    // no way to build a callback URL a remote hub could reach without a
    // configured public domain.
    private readonly feedFathomDomain?: string,
  ) {}

  public async parseSource(source: {
    id: number;
    skipCache?: boolean;
    url: string;
    websubCallbackToken?: null | string;
    websubHubUrl?: null | string;
    websubSecret?: null | string;
    websubStatus?: "failed" | "none" | "pending" | "verified";
    websubTopicUrl?: null | string;
  }) {
    try {
      const {
        cached,
        feed: parsedFeed,
        freshUntil,
        websub,
      } = await this.parseUrl(source.url, "background");

      if (
        websub &&
        (source.websubStatus === undefined ||
          source.websubStatus === "none" ||
          source.websubStatus === "pending")
      ) {
        await this.maybeSubscribeToWebSub(source.id, websub);
      }

      const observedAt = new Date();
      const articlesToUpsert = parsedFeed.items.map((item) =>
        Object.assign(
          mapFeedItemToArticle(
            item,
            parsedFeed,
            { id: source.id, url: source.url },
            rewriteLinks,
            observedAt.getTime(),
          ),
          { lastSeenInFeedAt: observedAt },
        ),
      );
      // batchUpsertArticles processes batches sequentially and a later
      // batch can fail after earlier ones already committed -- recompute
      // regardless of that outcome so committed articles aren't left
      // counted as unread-stale, then re-raise the original failure.
      let upsertError: unknown;
      try {
        await this.articlesDataService.batchUpsertArticles(articlesToUpsert);
      } catch (error) {
        upsertError = error;
      }
      try {
        await this.userSourcesDataService.recomputeUnreadCounts([source.id]);
      } catch (recomputeError) {
        // The upsert failure is the more actionable root cause -- don't
        // let a recompute failure silently replace it.
        if (upsertError === undefined) {
          throw recomputeError;
        }
        console.error(
          "recomputeUnreadCounts failed after batchUpsertArticles error:",
          recomputeError,
        );
      }
      if (upsertError !== undefined) {
        throw upsertError;
      }

      await this.sourcesDataService.successSource(
        source.id,
        cached,
        new Date(freshUntil ?? Date.now() + 5 * 60_000),
        observedAt,
      );
    } catch (error_: unknown) {
      if (isHttpDeferredError(error_)) {
        throw error_;
      }
      console.error("parseSource", error_);

      const message = error_ instanceof Error ? error_.message : String(error_);
      await this.sourcesDataService.failSource(source.id, message);
      console.error(`${source.url} failed`);
    }
  }

  public async parseUrl(
    url: string,
    priority: "background" | "interactive" = "interactive",
  ) {
    const resolvedUrl = await this.redirectMap.resolveUrl(url);
    return this.parseGenericFeed(resolvedUrl, url, priority);
  }

  // Errors here are deliberately never allowed to reach parseSource's own
  // try/catch -- a broken or unreachable hub says nothing about whether the
  // feed itself is healthy, so it must never mark the *source* as failed
  // (that would stop polling the actual feed content over a subscribe
  // attempt failing).
  private async maybeSubscribeToWebSub(
    sourceId: number,
    websub: NonNullable<
      Awaited<ReturnType<FeedParser["parseGenericFeed"]>>["websub"]
    >,
  ): Promise<void> {
    if (!this.feedFathomDomain) return;
    try {
      const { callbackToken, secret } =
        await this.sourcesDataService.recordWebSubDiscovery(
          sourceId,
          websub.hubUrl,
          websub.topicUrl,
        );
      const result = await requestHubSubscription({
        callbackUrl: `https://${this.feedFathomDomain}/api/websub/callback/${callbackToken}`,
        hubUrl: websub.hubUrl,
        mode: "subscribe",
        secret,
        topicUrl: websub.topicUrl,
      });
      if (!result.ok) {
        console.error(
          `WebSub subscribe failed for source ${sourceId}: ${result.error}`,
        );
        await this.sourcesDataService.markWebSubFailed(sourceId);
      }
    } catch (error) {
      console.error(`WebSub subscribe threw for source ${sourceId}:`, error);
      await this.sourcesDataService.markWebSubFailed(sourceId);
    }
  }

  public async preview(
    sourceUrl: string,
  ): Promise<ReturnType<typeof mapFeedToPreview> | undefined> {
    try {
      const { feed: parsedFeed, freshUntil } = await this.parseUrl(sourceUrl);
      return Object.assign(
        mapFeedToPreview(parsedFeed, sourceUrl, rewriteLinks),
        { freshUntil },
      );
    } catch (error_: unknown) {
      if (isHttpDeferredError(error_)) {
        throw error_;
      }
      return undefined;
    }
  }

  // The tree shows favicons at 1.5cap -- a few dozen CSS px even at a 2x
  // pixel density -- and since a warm favicon now gets embedded as base64
  // directly in the /api/tree response (see sw.js), every extra byte here
  // is paid on every tree load, not just once. 64px covers that display
  // size with headroom; prefer the smallest candidate that clears it over
  // always grabbing the biggest available, falling back to the biggest
  // undersized one when nothing meets the target at all.
  private static readonly TARGET_FAVICON_SIZE = 64;

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
      if (
        !best ||
        isBetterFavicon(size, best.size, FeedParser.TARGET_FAVICON_SIZE)
      ) {
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
      `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${source.homeUrl}&size=${FeedParser.TARGET_FAVICON_SIZE}`,
      `https://favicon.im/${source.homeUrl}`,
      `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
    ];

    const primary = await this.bestFavicon(primaryUrls);
    let result = primary;
    if (!primary.best) {
      const fallback = await this.bestFavicon([
        `https://unavatar.io/domain/${hostname}?size=${FeedParser.TARGET_FAVICON_SIZE}`,
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

  private async parseGenericFeed(
    fetchedUrl: string,
    originalUrl: string,
    priority: "background" | "interactive",
  ) {
    const response = await this.httpClient.get(fetchedUrl, {
      priority,
      responseType: "arrayBuffer",
    });
    this.validateFeedResponse(response, fetchedUrl);
    const finalUrl = response.url || fetchedUrl;
    // A 301/308 redirect is the origin telling us the move is permanent, so
    // persist it straight onto any subscribed source's URL; 302/303/307 are
    // temporary and only belong in the short-lived Redis redirect cache.
    const rememberRedirect = response.redirectedPermanently
      ? (from: string, to: string) =>
          this.sourcesDataService.updateSourceUrl(from, to)
      : (from: string, to: string) => this.redirectMap.setRedirect(from, to);
    if (finalUrl !== fetchedUrl) {
      await rememberRedirect(fetchedUrl, finalUrl);
    }
    if (originalUrl !== finalUrl) {
      await rememberRedirect(originalUrl, finalUrl);
    }
    const text = decodeFeedBody(
      response.data,
      response.headers.get("content-type"),
    );
    const parsedFeed = parseFeed(text);
    validateParsedFeed(parsedFeed);
    return {
      cached: response.cached,
      feed: parsedFeed,
      finalUrl,
      freshUntil: response.freshUntil,
      websub: discoverWebSub(response.headers, text, finalUrl),
    };
  }

  private validateFeedResponse(response: unknown, fetchedUrl: string): void {
    if (successfulFeedResponseCheck.Check(response)) return;

    console.error(`failed to load data for ${fetchedUrl}`);
    if (
      feedResponseStatusProjectionCheck.Check(response) &&
      !successfulStatusCheck.Check(response.status)
    ) {
      throw new Error(
        `Failed to load data for ${fetchedUrl}, received status ${response.status.toString()}`,
      );
    }
    throw new Error(
      `Failed to load data for ${fetchedUrl}, unexpected payload type`,
    );
  }
}

import { parseFeed } from "@rowanmanning/feed-parser";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { dateType, webUrlPolicy } from "#shared/validation/typebox-policy.ts";
import { type HttpClient } from "#platform/http/http-client.ts";
import { isHttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { isHttpDeadlineError } from "#platform/http/request-deadline.ts";
import type { RedirectMap } from "#platform/http/redirect-map.ts";
import {
  mapFeedItemToArticle,
  mapFeedToPreview,
} from "#features/feeds/feed-mapper.ts";
import {
  isJsonFeedText,
  parseJsonFeed,
} from "#features/feeds/json-feed-parser.ts";
import {
  isMicroformatHtml,
  parseMicroformatFeed,
} from "#features/feeds/microformat-feed-parser.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import {
  discoverWebSub,
  requestHubSubscription,
} from "#features/feeds/websub.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { rewriteLinks } from "#features/feeds/rewrite-links.ts";
import { shouldAttemptWebSubSubscribe } from "#features/feeds/websub-lease-policy.ts";

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
    // Unrecognized label; UTF-8 is the right default for almost every feed.
    return new TextDecoder("utf-8").decode(buffer);
  }
}

export function validateParsedFeed(value: unknown): void {
  if (!feedProjectionCheck.Check(value)) {
    throw new Error("Feed parser returned an invalid feed projection");
  }
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
    // Undefined skips WebSub (see maybeSubscribeToWebSub): without a public
    // domain there is no callback URL a hub could reach.
    private readonly feedFathomDomain?: string,
  ) {}

  public async parseSource(source: {
    id: number;
    skipCache?: boolean;
    subscriberCount?: number;
    trigger?: "manual" | "poll" | "websub-push";
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
      } = await this.parseUrl(
        source.url,
        "background",
        source.skipCache,
        source.subscriberCount,
      );

      if (websub && shouldAttemptWebSubSubscribe(source.websubStatus)) {
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
      // batchUpsertArticles commits batch by batch, so a later failure leaves
      // earlier articles committed. Recompute either way, then re-raise.
      let upsertError: unknown;
      try {
        await this.articlesDataService.batchUpsertArticles(articlesToUpsert);
      } catch (error) {
        upsertError = error;
      }
      try {
        await this.userSourcesDataService.recomputeUnreadCounts([source.id]);
      } catch (recomputeError) {
        // The upsert failure is the root cause; don't let this replace it.
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
        source.trigger ?? "poll",
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
    skipCache = false,
    // Left undefined by discovery and preview callers -- see buildUserAgent.
    subscribers?: number,
  ) {
    const resolvedUrl = await this.redirectMap.resolveUrl(url);
    return this.parseGenericFeed(
      resolvedUrl,
      url,
      priority,
      skipCache,
      subscribers,
    );
  }

  // Called from the subscribe route so discovery happens while adding the
  // source; otherwise a WebSub-capable feed sits on ordinary polling until
  // some later parseSource run.
  public async discoverAndSubscribeWebSub(
    sourceId: number,
    url: string,
    websubStatus?: "failed" | "none" | "pending" | "verified",
  ): Promise<void> {
    if (!shouldAttemptWebSubSubscribe(websubStatus)) return;
    try {
      const { websub } = await this.parseUrl(url, "interactive");
      if (websub) await this.maybeSubscribeToWebSub(sourceId, websub);
    } catch (error) {
      // The article-fetch path running alongside this (cached-preview upsert
      // or the enqueued parseSource job) already reports fetch/parse failures.
      console.error(
        `WebSub discovery fetch failed for source ${sourceId}:`,
        error,
      );
    }
  }

  // Never allowed to reach parseSource's try/catch: an unreachable hub says
  // nothing about the feed's health, and marking the source failed would stop
  // polling the content over a failed subscribe attempt.
  private async maybeSubscribeToWebSub(
    sourceId: number,
    websub: NonNullable<
      Awaited<ReturnType<FeedParser["parseGenericFeed"]>>["websub"]
    >,
  ): Promise<void> {
    if (!this.feedFathomDomain) return;
    try {
      if (
        !(await this.sourcesDataService.claimWebSubSubscribeAttempt(sourceId))
      )
        return;
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
      // A deferral and our own expired deadline both mean "we never got an
      // answer", which the error hook maps to a 429 and a 504. Collapsing
      // them into undefined would report our timeout as the user's bad URL.
      if (isHttpDeferredError(error_) || isHttpDeadlineError(error_)) {
        throw error_;
      }
      return undefined;
    }
  }

  // The tree shows favicons at 1.5cap, and a warm one is base64-inlined into
  // /api/tree (see sw.js), so every extra byte is paid on every tree load.
  // 64px covers that with headroom: take the smallest candidate that clears
  // it, or the biggest undersized one if none does.
  private async parseGenericFeed(
    fetchedUrl: string,
    originalUrl: string,
    priority: "background" | "interactive",
    skipCache = false,
    subscribers?: number,
  ) {
    const response = await this.httpClient.get(fetchedUrl, {
      priority,
      responseType: "arrayBuffer",
      skipCache,
      ...(subscribers === undefined ? {} : { subscribers }),
    });
    this.validateFeedResponse(response, fetchedUrl);
    const finalUrl = response.url || fetchedUrl;
    // 301/308 are permanent, so persist onto the subscribed source's URL;
    // 302/303/307 belong only in the short-lived Redis redirect cache.
    const rememberRedirect = response.redirectedPermanently
      ? (from: string, to: string) =>
          this.sourcesDataService.updateSourceUrl(from, to)
      : (from: string, to: string) => this.redirectMap.setRedirect(from, to);
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
    const contentType = response.headers.get("content-type");
    const text = decodeFeedBody(response.data, contentType);
    const parsedFeed = isJsonFeedText(text)
      ? parseJsonFeed(text)
      : isMicroformatHtml(text, contentType)
        ? parseMicroformatFeed(text, finalUrl)
        : parseFeed(text);
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
      response.status !== 200
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

import { parseFeed } from "@rowanmanning/feed-parser";
import { Element } from "@rowanmanning/feed-parser/lib/xml/element.js";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { dateType } from "#shared/validation/typebox-policy.ts";
import { type HttpClient } from "#platform/http/http-client.ts";
import { rejectXmlEntityDeclarations } from "#platform/xml.ts";
import { isHttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { isHttpDeadlineError } from "#platform/http/request-deadline.ts";
import type { RedirectMap } from "#platform/http/redirect-map.ts";
import {
  inCapScope,
  mentionsCapNamespace,
  readCapAlert,
} from "#features/feeds/cap-entry.ts";
import { parseFeedDate } from "#features/feeds/feed-date.ts";
import {
  type FeedMapperItem,
  currentFeedItems,
  mapFeedItemToArticle,
  mapFeedToPreview,
} from "#features/feeds/feed-mapper.ts";
import {
  asHtmlText,
  isJsonFeedText,
  parseJsonFeed,
} from "#features/feeds/json-feed-parser.ts";
import {
  isMicroformatHtml,
  parseMicroformatFeed,
} from "#features/feeds/microformat-feed-parser.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import {
  discoverWebSub,
  requestHubSubscription,
  type WebSubDiscovery,
} from "#features/feeds/websub.ts";
import type { ArticleImporter } from "#features/feeds/article-import.ts";
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
  if (charset) return charset.replace(/^"(.*)"$/, "$1");

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

// feed-parser reads every RSS and Atom date, on items and on the feed, through
// this one getter, which hands the text to a bare `new Date`. Replacing the
// getter routes them all through parseFeedDate; the date-zones fixtures fail
// if a feed-parser release stops reading dates through it.
Object.defineProperty(Element.prototype, "textContentAsDate", {
  get(this: Element) {
    return parseFeedDate(this.textContent);
  },
});

type XmlElement = ReturnType<typeof parseFeed>["items"][number]["element"];

const isMediaRss = (element: XmlElement) =>
  element.namespaceUri === "http://search.yahoo.com/mrss/" ||
  element.namespaceUri === "https://search.yahoo.com/mrss/";

// Media RSS's description, on the entry or its media:group. It is plain text.
const mediaDescription = (element: XmlElement) =>
  [element, ...element.findElementsWithName("group").filter(isMediaRss)]
    .flatMap((parent) => parent.findElementsWithName("description"))
    .find((child) => isMediaRss(child) && child.textContent.trim())
    ?.textContent;

/**
 * Parses an RSS or Atom feed. Each entry in CAP namespace scope also gets its
 * alert fields, if any, as `cap`, and its `xml:lang`, else the
 * `language=en-CA` category NAAD uses, else "", as `language`; see
 * generateArticleGuid. An entry with no body of its own,
 * such as every YouTube video, takes its Media RSS description instead.
 */
export const parseXmlFeed = (text: string) => {
  rejectXmlEntityDeclarations(text);
  const feed = parseFeed(text);
  // An item without its own url, authors or categories falls back to the
  // feed's, which the library recomputes on every read by wrapping each child
  // of the channel, items included. Pinned once, reading every item is linear
  // in the item count instead of quadratic (#1031).
  for (const key of ["authors", "categories", "url"] as const) {
    Object.defineProperty(feed, key, { value: feed[key] });
  }
  for (const item of feed.items) {
    if (item.content !== null || item.description !== null) continue;
    const description = asHtmlText(mediaDescription(item.element));
    // The prototype's getter has no setter, so plain assignment would throw.
    if (description)
      Object.defineProperty(item, "description", { value: description });
  }
  if (!mentionsCapNamespace(text)) return feed;
  for (const item of feed.items.filter(({ element }) => inCapScope(element))) {
    const language =
      item.element.getAttribute("xml:lang") ??
      item.categories
        .find(({ term }) => term.startsWith("language="))
        ?.term.slice("language=".length) ??
      "";
    const cap = readCapAlert(item.element);
    Object.assign(item, cap ? { cap, language } : { language });
  }
  return feed;
};

export class FeedParser {
  constructor(
    private readonly articleImporter: Pick<ArticleImporter, "importArticles">,
    private readonly httpClient: HttpClient,
    private readonly sourcesDataService: Pick<
      SourcesDataService,
      "failSource" | "successSource" | "updateSourceUrl"
    >,
    private readonly websubStateService: Pick<
      WebSubStateService,
      | "claimWebSubSubscribeAttempt"
      | "markWebSubFailed"
      | "recordWebSubDiscovery"
    >,
    private readonly redirectMap: RedirectMap,
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
        finalUrl,
        freshUntil,
        websub,
      } = await this.parseUrl(source.url, {
        priority: "background",
        skipCache: source.skipCache,
        subscribers: source.subscriberCount,
        websub:
          this.feedFathomDomain !== undefined &&
          shouldAttemptWebSubSubscribe(source.websubStatus),
      });

      if (websub) await this.maybeSubscribeToWebSub(source.id, websub);

      const observedAt = new Date();
      const articlesToUpsert = currentFeedItems<FeedMapperItem>(
        parsedFeed.items,
        observedAt.getTime(),
      ).map((item) =>
        Object.assign(
          mapFeedItemToArticle(
            item,
            parsedFeed,
            { id: source.id, url: source.url },
            { baseUrl: finalUrl, now: observedAt.getTime() },
          ),
          { lastSeenInFeedAt: observedAt },
        ),
      );
      await this.articleImporter.importArticles(source.id, articlesToUpsert);

      await this.sourcesDataService.successSource(
        source.id,
        cached,
        freshUntil ? new Date(freshUntil) : undefined,
        observedAt,
        source.trigger ?? "poll",
      );
    } catch (error_: unknown) {
      if (isHttpDeferredError(error_)) {
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
    websubStatus?: "failed" | "none" | "pending" | "verified",
  ): Promise<void> {
    if (!this.feedFathomDomain || !shouldAttemptWebSubSubscribe(websubStatus))
      return;
    try {
      const { websub } = await this.parseUrl(url);
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
    websub: WebSubDiscovery,
  ): Promise<void> {
    const domain = this.feedFathomDomain;
    if (!domain) return;
    try {
      if (
        !(await this.websubStateService.claimWebSubSubscribeAttempt(sourceId))
      )
        return;
      const { callbackToken, secret } =
        await this.websubStateService.recordWebSubDiscovery(
          sourceId,
          websub.hubUrl,
          websub.topicUrl,
        );
      const result = await requestHubSubscription({
        callbackToken,
        domain,
        hubPoster: this.httpClient,
        hubUrl: websub.hubUrl,
        secret,
        topicUrl: websub.topicUrl,
      });
      if (!result.ok) {
        console.error(
          `WebSub subscribe failed for source ${sourceId}: ${result.error}`,
        );
        await this.websubStateService.markWebSubFailed(sourceId);
      }
    } catch (error) {
      console.error(`WebSub subscribe threw for source ${sourceId}:`, error);
      await this.websubStateService.markWebSubFailed(sourceId);
    }
  }

  public async preview(
    sourceUrl: string,
  ): Promise<ReturnType<typeof mapFeedToPreview> | undefined> {
    try {
      const {
        feed: parsedFeed,
        finalUrl,
        freshUntil,
      } = await this.parseUrl(sourceUrl, { websub: false });
      return Object.assign(
        mapFeedToPreview(parsedFeed, sourceUrl, { baseUrl: finalUrl }),
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
    const jsonFeed = isJsonFeedText(text) ? parseJsonFeed(text) : undefined;
    const parsedFeed =
      jsonFeed ??
      (isMicroformatHtml(text, contentType)
        ? parseMicroformatFeed(text, finalUrl)
        : parseXmlFeed(text));
    validateParsedFeed(parsedFeed);
    return {
      cached: response.cached,
      feed: parsedFeed,
      finalUrl,
      freshUntil: response.freshUntil,
      websub: websub
        ? discoverWebSub(
            response.headers,
            text,
            finalUrl,
            jsonFeed?.websubHubUrl,
          )
        : undefined,
    };
  }
}

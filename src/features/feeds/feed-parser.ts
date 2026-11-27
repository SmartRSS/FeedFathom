import { Type } from "typebox";
import Schema from "typebox/schema";
import type {
  FetchTrigger,
  WebSubStatus,
} from "#platform/db/schemas/sources.ts";
import { type HttpClient } from "#platform/http/http-client.ts";
import type { Priority } from "#platform/http/http-rate-limiter.ts";
import {
  HttpDeferredError,
  isNoAnswerError,
} from "#platform/http/http-deferred-error.ts";
import type { RedirectMap } from "#features/feeds/redirect-map.ts";
import {
  feedFormat,
  parseFeedDocument,
} from "#features/feeds/feed-document.ts";
import {
  type FeedMapperInput,
  feedHomeUrl,
  mapFeedToArticles,
  mapFeedToPreview,
} from "#features/feeds/feed-mapper.ts";
import { lastSeenBumpThrottleHours } from "#features/feeds/retention.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { discoverWebSub } from "#features/feeds/websub.ts";
import type { WebSubSubscriber } from "#features/feeds/websub-subscriber.ts";
import type { ArticleImporter } from "#features/feeds/article-import.ts";
import { decodeXml } from "#shared/util/decode-body.ts";
import { httpStatusFailure } from "#shared/util/fetch-failure.ts";

const jsonHubsPattern = /"hubs"\s*:/u;
const jsonFeedHubsCheck = Schema.Compile(
  Type.Object(
    {
      hubs: Type.Array(
        Type.Object(
          {
            type: Type.Optional(Type.Unknown()),
            url: Type.Optional(Type.Unknown()),
          },
          { additionalProperties: true },
        ),
      ),
    },
    { additionalProperties: true },
  ),
);

function extractJsonFeedHubUrl(text: string): string | undefined {
  if (!jsonHubsPattern.test(text)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!jsonFeedHubsCheck.Check(parsed)) return undefined;
    for (const hub of parsed.hubs) {
      if (hub.type === "WebSub" && typeof hub.url === "string") {
        return hub.url;
      }
    }
  } catch {}
  return undefined;
}

const sha256Hex = (data: ArrayBuffer): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

export class FeedParser {
  constructor(
    private readonly articleImporter: Pick<ArticleImporter, "recordFetch">,
    private readonly httpClient: HttpClient,
    private readonly sourcesDataService: Pick<
      SourcesDataService,
      "failSource" | "updateSourceUrl"
    > &
      Partial<
        Pick<SourcesDataService, "canSkipUnchangedBody" | "successSource">
      >,
    private readonly webSubSubscriber: Pick<
      WebSubSubscriber,
      "subscribe" | "wants"
    >,
    private readonly redirectMap: RedirectMap,
  ) {}

  public async parseSource(source: {
    id: number;
    lastBodyHash?: null | string;
    skipCache?: boolean;
    subscriberCount?: number;
    trigger?: FetchTrigger;
    url: string;
    websubStatus?: WebSubStatus;
  }) {
    try {
      const wantsWebSub = this.webSubSubscriber.wants(source.websubStatus);
      const { cached, data, finalUrl, freshUntil, headers } =
        await this.fetchFeed(source.url, {
          priority: "background",
          skipCache: source.skipCache,
          subscribers: source.subscriberCount,
        });
      const bodyHash = sha256Hex(data);

      if (
        !wantsWebSub &&
        source.lastBodyHash === bodyHash &&
        this.sourcesDataService.canSkipUnchangedBody &&
        this.sourcesDataService.successSource &&
        (await this.sourcesDataService.canSkipUnchangedBody(
          source.id,
          lastSeenBumpThrottleHours,
        ))
      ) {
        await this.sourcesDataService.successSource(source.id, {
          cached,
          notBefore: freshUntil ? new Date(freshUntil) : undefined,
          trigger: source.trigger ?? "poll",
        });
        return;
      }

      const { feed, text, websubHubUrl } = parseFeedDocument(
        data,
        headers.get("content-type"),
        finalUrl,
      );
      const websub = wantsWebSub
        ? discoverWebSub(headers, text, finalUrl, websubHubUrl)
        : undefined;

      if (websub) await this.webSubSubscriber.subscribe(source.id, websub);

      await this.articleImporter.recordFetch(
        source.id,
        mapFeedToArticles(feed, source.url, { baseUrl: finalUrl }),
        {
          bodyHash,
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

  public async discoverAndSubscribeWebSub(
    sourceId: number,
    url: string,
    websubStatus?: WebSubStatus,
  ): Promise<void> {
    if (!this.webSubSubscriber.wants(websubStatus)) return;
    try {
      const { websub } = await this.parseUrl(url, { metadataOnly: true });
      if (websub) await this.webSubSubscriber.subscribe(sourceId, websub);
    } catch (error) {
      console.error(
        `WebSub discovery fetch failed for source ${sourceId}:`,
        error,
      );
    }
  }

  public async preview(
    sourceUrl: string,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof mapFeedToPreview> | { failure: string }> {
    try {
      const { feed, finalUrl, freshUntil } = await this.parseUrl(sourceUrl, {
        signal,
        websub: false,
      });
      return Object.assign(
        mapFeedToPreview(feed, sourceUrl, { baseUrl: finalUrl }),
        { freshUntil },
      );
    } catch (error_: unknown) {
      if (isNoAnswerError(error_)) throw error_;
      return { failure: error_ instanceof Error ? error_.message : "" };
    }
  }

  public async parseUrl(
    originalUrl: string,
    {
      metadataOnly = false,
      priority = "interactive",
      signal,
      skipCache = false,
      subscribers,
      websub = true,
    }: {
      metadataOnly?: boolean;
      priority?: Priority;
      signal?: AbortSignal | undefined;
      skipCache?: boolean | undefined;
      subscribers?: number | undefined;
      websub?: boolean;
    } = {},
  ) {
    const { cached, data, finalUrl, freshUntil, headers } =
      await this.fetchFeed(originalUrl, {
        priority,
        signal,
        skipCache,
        subscribers,
      });
    if (metadataOnly) {
      const contentType = headers.get("content-type");
      const text = decodeXml(new Uint8Array(data), contentType);
      const jsonFeedHubUrl =
        feedFormat(text, contentType) === "json"
          ? extractJsonFeedHubUrl(text)
          : undefined;
      const emptyFeed: FeedMapperInput = {
        description: null,
        items: [],
        title: null,
        url: finalUrl,
      };
      return {
        cached,
        feed: emptyFeed,
        finalUrl,
        freshUntil,
        websub: websub
          ? discoverWebSub(headers, text, finalUrl, jsonFeedHubUrl)
          : undefined,
      };
    }
    const { feed, text, websubHubUrl } = parseFeedDocument(
      data,
      headers.get("content-type"),
      finalUrl,
    );
    return {
      cached,
      feed,
      finalUrl,
      freshUntil,
      websub: websub
        ? discoverWebSub(headers, text, finalUrl, websubHubUrl)
        : undefined,
    };
  }

  private async fetchFeed(
    originalUrl: string,
    {
      priority,
      signal,
      skipCache = false,
      subscribers,
    }: {
      priority: Priority;
      signal?: AbortSignal | undefined;
      skipCache?: boolean | undefined;
      subscribers?: number | undefined;
    },
  ) {
    const fetchedUrl = await this.redirectMap.resolveUrl(originalUrl);
    const response = await this.httpClient.get(fetchedUrl, {
      priority,
      signal,
      skipCache,
      ...(subscribers === undefined ? {} : { subscribers }),
    });
    if (response.status !== 200) {
      throw new Error(httpStatusFailure(fetchedUrl, response.status));
    }
    const finalUrl = response.url;
    const rememberRedirect = response.redirectedPermanently
      ? (from: string, to: string) =>
          this.sourcesDataService.updateSourceUrl(from, to)
      : (from: string, to: string) =>
          this.redirectMap.setRedirect(from, to).catch((error: unknown) => {
            console.error(`Could not cache redirect ${from} -> ${to}:`, error);
          });
    if (finalUrl !== fetchedUrl) {
      await rememberRedirect(fetchedUrl, finalUrl);
      if (originalUrl !== fetchedUrl) {
        await rememberRedirect(originalUrl, finalUrl);
      }
    }
    return {
      cached: response.cached,
      data: response.data,
      finalUrl,
      freshUntil: response.freshUntil,
      headers: response.headers,
    };
  }
}

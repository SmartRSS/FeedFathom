import { lookup } from "node:dns/promises";
import { parseFeed } from "@rowanmanning/feed-parser";
import { AxiosError } from "axios";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import type { RedisClient } from "bun";
import container from "../container.ts";
import type { ArticlesDataService } from "../db/data-services/article-data-service.ts";
import type { SourcesDataService } from "../db/data-services/source-data-service.ts";
import { logError as error } from "../util/log.ts";
import { mapFeedItemToArticle, mapFeedToPreview } from "./feed-mapper.ts";
import type { RedirectMap } from "./redirect-map.ts";
import { rewriteLinks } from "./rewrite-links.ts";

// const parserStrategies: Record<string, (url: string) => Promise<Feed | void>> =
//   {};

export class FeedParser {
  private readonly defaultDelay = 10_000;

  private domainDelaySettings: Record<string, number> = {
    "feeds.feedburner.com": 5_000,
    "openrss.org": 2_500,
    "youtube.com": 2_500,
  };

  constructor(
    private readonly articlesDataService: ArticlesDataService,
    private readonly axiosInstance: AxiosCacheInstance,
    private readonly redis: RedisClient,
    private readonly sourcesDataService: SourcesDataService,
    private readonly redirectMap: RedirectMap,
  ) {}

  private formatErrorMessage(error_: unknown): string {
    if (error_ instanceof AxiosError) {
      return [
        error_.cause instanceof Object
          ? JSON.stringify(error_.cause)
          : "unknown cause",
        error_.code ?? "no code",
        error_.message,
        String(error_.response?.status ?? "no status"),
        typeof error_.response?.data === "string"
          ? error_.response.data
          : JSON.stringify(error_.response?.data ?? "no data"),
      ].join("\n");
    }
    return error_ instanceof Error ? error_.message : String(error_);
  }

  public async parseSource(source: {
    id: number;
    skipCache?: boolean;
    url: string;
  }) {
    try {
      if (
        !(await this.canDomainBeProcessedAlready(new URL(source.url).hostname))
      ) {
        return;
      }

      const {
        cached,
        feed: parsedFeed,
        finalUrl,
        permanentRedirect,
      } = await this.parseUrl(source.url);

      if (cached && !source.skipCache) {
        // Mark this source as successfully processed using cached data
        await this.sourcesDataService.successSource(source.id, true);
        return;
      }

      const articlePayloads = parsedFeed.items.map((item) => {
        return mapFeedItemToArticle(
          item,
          parsedFeed,
          { id: source.id, url: source.url },
          rewriteLinks,
        );
      });
      const date = new Date();

      const articlesToUpsert = articlePayloads.map((payload) => ({
        guid: payload.guid,
        sourceId: payload.sourceId,
        title: payload.title,
        url: payload.url,
        author: payload.author,
        publishedAt: payload.publishedAt ?? date,
        content: payload.content ?? "",
        updatedAt: date,
        lastSeenInFeedAt: date,
      }));
      await this.articlesDataService.batchUpsertArticles(articlesToUpsert);
      articlePayloads.length = 0;

      await this.sourcesDataService.successSource(source.id);

      // If we encountered a permanent redirect (301/308) – rewrite the source
      // URL so future fetches go directly to the canonical location.
      if (permanentRedirect && finalUrl && finalUrl !== source.url) {
        try {
          await this.sourcesDataService.updateSourceUrl(source.url, finalUrl);
          // Keep the in-memory object in sync to avoid duplicate work later in
          // this method – especially important for the successSource call.
          source.url = finalUrl;
        } catch (updateError) {
          // Non-critical – log and continue so feed parsing still succeeds.
          error(
            `Failed to update source URL from ${source.url} to ${finalUrl}:`,
            updateError,
          );
        }
      }
    } catch (error_: unknown) {
      if (error_ instanceof Error) {
        error("parseSource", error_.message);
      } else {
        error("parseSource", error_);
      }

      const message = this.formatErrorMessage(error_);
      await this.sourcesDataService.failSource(source.id, message);
      error(`${source.url} failed`);
    }
  }

  public async parseUrl(url: string) {
    // Remember the originally supplied URL so that we can create a direct mapping
    // from it to the final resolved URL (to avoid redirect chains).

    // Check for redirect mapping first – if we already know that `url` redirects
    // somewhere else, we will fetch that destination instead.
    const resolvedUrl = await this.redirectMap.resolveUrl(url);

    const urlObject = new URL(resolvedUrl);
    const lookupResult = await lookup(urlObject.hostname);
    if (!lookupResult.address) {
      throw new Error(`Failed to resolve ${urlObject.hostname}`);
    }

    // const chosenParser =
    //   parserStrategies[urlObject.origin] ?? this.parseGenericFeed;
    // return await chosenParser.bind(this)(resolvedUrl);

    // Pass along both the URL we are actually fetching (resolvedUrl) and the
    // originally provided URL so that the parser can store proper redirect
    // mappings without creating inefficient chains (A -> C instead of A -> B -> C).
    return await this.parseGenericFeed(resolvedUrl, url);
  }

  public async preview(sourceUrl: string) {
    try {
      const { feed: parsedFeed } = await this.parseUrl(sourceUrl);
      return mapFeedToPreview(parsedFeed, sourceUrl);
    } catch {
      return {};
    }
  }

  public async refreshFavicon(source: { homeUrl: string; id: number }) {
    const urls = [
      `https://icons.duckduckgo.com/ip3/${source.homeUrl}.ico`,
      `https://unavatar.io/${source.homeUrl}`,
      `https://favicon.im/${source.homeUrl}`,
      `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${source.homeUrl}&size=64`,
    ];

    for (const url of urls) {
      try {
        const response = await container.cradle.axiosInstance.get(url, {
          responseType: "arraybuffer",
        });

        if (response.status !== 200 || !response.data) {
          continue;
        }

        let faviconPayload: string;

        if (response.data instanceof ArrayBuffer) {
          const buffer = Buffer.from(response.data);
          // Ignore small responses, likely errors or blank images
          if (buffer.length < 20) {
            continue;
          }
          const contentType = response.headers["content-type"] ?? "image/png";
          faviconPayload = `data:${contentType};base64,${buffer.toString(
            "base64",
          )}`;
        } else if (typeof response.data === "string") {
          // If it's a string, it must be a data URI, otherwise we don't know how to handle it.
          if (response.data.startsWith("data:image")) {
            faviconPayload = response.data;
          } else {
            continue;
          }
        } else {
          // Unsupported type
          continue;
        }

        await this.sourcesDataService.updateFavicon(source.id, faviconPayload);
        // Exit loop after successful update
        break;
      } catch {
        // nop
      }
    }
  }

  private async canDomainBeProcessedAlready(domain: string): Promise<boolean> {
    const now = Date.now();
    const lastFetchKey = `lastFetchTimestamp:${domain}`;
    const rateLimitKey = `rateLimitUntil:${domain}`;

    // Check for dynamic rate limit (set by Retry-After or similar)
    const rateLimitUntil = Number.parseInt(
      (await this.redis.get(rateLimitKey)) ?? "0",
      10,
    );
    if (now < rateLimitUntil) {
      error(
        `Domain ${domain} is rate limited until ${new Date(rateLimitUntil).toISOString()}`,
      );
      return false;
    }

    const lastFetchTimestamp = Number.parseInt(
      (await this.redis.get(lastFetchKey)) ?? "0",
      10,
    );

    const delaySetting = this.domainDelaySettings[domain] ?? this.defaultDelay;
    if (now < lastFetchTimestamp + delaySetting) {
      return false;
    }

    await this.redis.set(lastFetchKey, now.toString());
    return true;
  }

  /**
   * Generic feed parsing logic.
   *
   * @param fetchedUrl   The URL we are going to request (possibly already resolved by a previous redirect mapping).
   * @param originalUrl  The URL originally supplied to `parseUrl`. This can be different from `fetchedUrl` when a redirect
   *                     mapping already exists. Providing it allows us to store a direct mapping from the original URL to
   *                     the final one and avoid redirect chains.
   */
  private async parseGenericFeed(fetchedUrl: string, originalUrl?: string) {
    let response: Awaited<ReturnType<AxiosCacheInstance["get"]>> & {
      status: number;
      data: unknown;
      headers: Record<string, string>;
      request?: { res?: { responseUrl?: string } };
      config: { url?: string };
      cached?: boolean;
    };
    try {
      response = await this.axiosInstance.get(fetchedUrl);
      const domain = new URL(fetchedUrl).hostname;
      await this.handleUpcomingRateLimitHeaders(response, domain);
      this.validateFeedResponse(response, fetchedUrl);
      const finalUrl = this.getFinalUrl(response, fetchedUrl);
      const permanentRedirect = await this.handleRedirects(
        fetchedUrl,
        finalUrl,
      );
      if (finalUrl !== fetchedUrl) {
        await this.redirectMap.setRedirect(fetchedUrl, finalUrl);
      }
      if (originalUrl && originalUrl !== finalUrl) {
        await this.redirectMap.setRedirect(originalUrl, finalUrl);
      }
      return {
        cached: response.cached ?? false,
        feed: parseFeed(response.data as string),
        finalUrl,
        permanentRedirect,
      };
    } catch (err) {
      await this.handleRateLimitError(err, fetchedUrl);
      throw err;
    }
  }

  // --- Helper methods ---

  private async handleUpcomingRateLimitHeaders(
    response: { headers: Record<string, string> },
    domain: string,
  ): Promise<void> {
    const rateLimitReset = response.headers["x-ratelimit-reset"];
    const rateLimitRemaining = response.headers["x-ratelimit-remaining"];
    if (rateLimitRemaining !== undefined && rateLimitReset !== undefined) {
      const remaining = Number(rateLimitRemaining);
      const reset = Number(rateLimitReset);
      if (!Number.isNaN(remaining) && remaining <= 1 && !Number.isNaN(reset)) {
        const waitUntil = reset * 1000;
        if (waitUntil > Date.now()) {
          await this.redis.set(
            `rateLimitUntil:${domain}`,
            waitUntil.toString(),
          );
          error(
            `Upcoming rate limit for ${domain}, pausing requests until ${new Date(waitUntil).toISOString()}`,
          );
        }
      }
    }
  }

  private validateFeedResponse(
    response: { status: number; data: unknown },
    fetchedUrl: string,
  ): void {
    if (response.status !== 200) {
      error(`failed to load data for ${fetchedUrl}`);
      throw new Error(
        `Failed to load data for ${fetchedUrl}, received status ${response.status.toString()}`,
      );
    }
    if (typeof response.data !== "string") {
      error(`failed to load data for ${fetchedUrl}`);
      throw new Error(
        `Failed to load data for ${fetchedUrl}, unexpected payload type`,
      );
    }
  }

  private getFinalUrl(
    response: {
      request?: { res?: { responseUrl?: string } };
      config: { url?: string };
    },
    fetchedUrl: string,
  ): string {
    return (
      (response.request &&
      typeof response.request === "object" &&
      "res" in response.request &&
      response.request.res &&
      typeof response.request.res === "object" &&
      "responseUrl" in response.request.res
        ? (response.request.res.responseUrl as string | undefined)
        : undefined) ??
      response.config.url ??
      fetchedUrl
    );
  }

  private async handleRedirects(
    fetchedUrl: string,
    finalUrl: string,
  ): Promise<boolean> {
    let permanentRedirect = false;
    if (finalUrl !== fetchedUrl) {
      try {
        const redirectCheck = await this.axiosInstance.get(fetchedUrl, {
          maxRedirects: 0,
          validateStatus: (status) => status >= 300 && status < 400,
        });
        permanentRedirect =
          redirectCheck.status === 301 || redirectCheck.status === 308;
      } catch {
        permanentRedirect = false;
      }
    }
    return permanentRedirect;
  }

  private async handleRateLimitError(
    err: unknown,
    fetchedUrl: string,
  ): Promise<void> {
    if (err instanceof AxiosError && err.response?.status === 429) {
      const domain = new URL(fetchedUrl).hostname;
      const retryAfter = err.response.headers["retry-after"];
      let waitUntil = Date.now();
      let parsed = false;
      if (retryAfter) {
        const retryAfterSeconds = Number(retryAfter);
        if (!Number.isNaN(retryAfterSeconds)) {
          waitUntil += retryAfterSeconds * 1000;
          parsed = true;
        } else {
          const date = Date.parse(retryAfter);
          if (!Number.isNaN(date)) {
            waitUntil = date;
            parsed = true;
          }
        }
      }
      // Fallback: if Retry-After is missing or unparseable, use 5 minutes
      if (!parsed) {
        waitUntil += 5 * 60 * 1000;
      }
      await this.redis.set(`rateLimitUntil:${domain}`, waitUntil.toString());
      error(
        `Received 429 for ${fetchedUrl}, rate limiting domain ${domain} until ${new Date(waitUntil).toISOString()}`,
      );
      throw new Error(
        `Rate limited by ${domain}, retry after ${new Date(waitUntil).toISOString()}`,
      );
    }
  }
}

import { lookup } from "node:dns/promises";
import { AxiosError } from "axios";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import type { RedisClient } from "bun";
import container from "../container.ts";
import type { ArticlesDataService } from "../db/data-services/article-data-service.ts";
import type { SourcesDataService } from "../db/data-services/source-data-service.ts";
import type {
  DomainProcessingState,
  ErrorContext,
  FaviconPayload,
  FaviconResponse,
  FeedParserError,
  NetworkError,
  RedisSetResult,
} from "../types/feed-parser-types.ts";
import { logError } from "../util/log.ts";
import { FeedParserStrategyRegistry } from "./feed-strategies/index.ts";
import type { RedirectMap } from "./redirect-map.ts";

export class FeedParser {
  private readonly defaultDelay = 10_000;

  private domainDelaySettings: Record<string, number> = {};

  private readonly strategyRegistry: FeedParserStrategyRegistry;

  constructor(
    private readonly articlesDataService: ArticlesDataService,
    private readonly axiosInstance: AxiosCacheInstance,
    private readonly redis: RedisClient,
    private readonly sourcesDataService: SourcesDataService,
    private readonly redirectMap: RedirectMap,
  ) {
    this.strategyRegistry = new FeedParserStrategyRegistry({
      axiosInstance: this.axiosInstance,
      redis: this.redis,
      redirectMap: this.redirectMap,
    });
  }

  private formatErrorMessage(
    error_: FeedParserError | Error | unknown,
  ): string {
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
    strategyType?: string | undefined;
    strategyConfig?: string | undefined;
    sourceType?: "feed" | "newsletter" | "websub";
  }) {
    try {
      // Skip processing for newsletters and websub sources
      if (
        source.sourceType === "newsletter" ||
        source.sourceType === "websub"
      ) {
        logError(`Skipping ${source.sourceType} source: ${source.url}`);
        return;
      }

      const domainState = await this.canDomainBeProcessedAlready(
        new URL(source.url).hostname,
      );
      if (!domainState.canProcess) {
        logError(`Domain processing blocked: ${domainState.reason}`);
        return;
      }

      // Detect strategy if not stored
      if (!source.strategyType) {
        try {
          const strategyInfo = await this.strategyRegistry.detectStrategyForUrl(
            source.url,
          );
          await this.sourcesDataService.updateStrategy(source.id, strategyInfo);

          // Update source object with detected strategy
          source.strategyType = strategyInfo.strategy;
          source.strategyConfig = strategyInfo.config;
          source.sourceType = strategyInfo.sourceType;

          // Skip if detected as newsletter or websub
          if (
            strategyInfo.sourceType === "newsletter" ||
            strategyInfo.sourceType === "websub"
          ) {
            logError(
              `Source detected as ${strategyInfo.sourceType}, skipping: ${source.url}`,
            );
            return;
          }
        } catch (detectionError) {
          logError(
            `Strategy detection failed for ${source.url}:`,
            detectionError,
          );
          // Continue with generic strategy as fallback
        }
      }

      const { cached, articles, finalUrl, permanentRedirect } =
        await this.parseUrl(
          source.url,
          source.id,
          source.strategyType,
          source.strategyConfig,
        );

      // Handle permanent redirects immediately so that we do not skip the
      // update when we exit early for a cache-hit.
      if (permanentRedirect && finalUrl && finalUrl !== source.url) {
        try {
          await this.sourcesDataService.updateSourceUrl(source.url, finalUrl);
          source.url = finalUrl;
        } catch (updateError) {
          logError(
            `Failed to update source URL from ${source.url} to ${finalUrl}:`,
            updateError,
          );
        }
      }

      if (cached && !source.skipCache) {
        // Mark this source as successfully processed using cached data
        await this.sourcesDataService.successSource(source.id, true);
        return;
      }

      await this.articlesDataService.batchUpsertArticles(articles);

      await this.sourcesDataService.successSource(source.id);
    } catch (error_: unknown) {
      const context: ErrorContext = {
        url: source.url,
        sourceId: source.id,
        timestamp: new Date(),
      };

      if (error_ instanceof Error) {
        logError("parseSource", error_.message, context);
      } else {
        logError("parseSource", error_, context);
      }

      const message = this.formatErrorMessage(error_);
      await this.sourcesDataService.failSource(source.id, message);
      logError(`${source.url} failed`);
    }
  }

  public async parseUrl(
    url: string,
    sourceId: number,
    storedStrategy?: string,
    storedConfig?: string,
  ) {
    // Remember the originally supplied URL so that we can create a direct mapping
    // from it to the final resolved URL (to avoid redirect chains).

    // Check for redirect mapping first – if we already know that `url` redirects
    // somewhere else, we will fetch that destination instead.
    const resolvedUrl = await this.redirectMap.resolveUrl(url);

    const urlObject = new URL(resolvedUrl);
    const lookupResult = await lookup(urlObject.hostname);
    if (!lookupResult.address) {
      const networkError: NetworkError = new Error(
        `Failed to resolve ${urlObject.hostname}`,
      ) as NetworkError;
      networkError.code = "NETWORK_ERROR";
      networkError.url = url;
      throw networkError;
    }

    // Use the strategy pattern with stored strategy information
    const { result, cached, finalUrl, permanentRedirect } =
      await this.strategyRegistry.parseWithDetection(
        resolvedUrl,
        sourceId,
        url,
        storedStrategy,
        storedConfig,
      );

    return {
      ...result,
      cached,
      finalUrl,
      permanentRedirect,
    };
  }

  public async preview(sourceUrl: string) {
    try {
      const { feedInfo, strategyType } =
        await this.strategyRegistry.getInfoWithDetection(sourceUrl);

      return {
        title: feedInfo.title,
        description: feedInfo.description,
        link: feedInfo.link,
        feedUrl: sourceUrl,
        type: strategyType,
      };
    } catch (error: unknown) {
      const context: ErrorContext = {
        url: sourceUrl,
        timestamp: new Date(),
      };
      if (error instanceof Error) {
        logError("preview failed", error.message, context);
      } else {
        logError("preview failed", error, context);
      }
      return null;
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
        const response = (await container.cradle.axiosInstance.get(url, {
          responseType: "arraybuffer",
        })) as FaviconResponse;

        if (response.status !== 200 || !response.data) {
          continue;
        }

        const faviconPayload = this.processFaviconResponse(response);
        if (faviconPayload) {
          await this.sourcesDataService.updateFavicon(
            source.id,
            faviconPayload.dataUri,
          );
          // Exit loop after successful update
          break;
        }
      } catch (error_: unknown) {
        const context: ErrorContext = {
          url,
          sourceId: source.id,
          timestamp: new Date(),
        };
        logError("Favicon refresh failed", error_, context);
      }
    }
  }

  private processFaviconResponse(
    response: FaviconResponse,
  ): FaviconPayload | null {
    try {
      if (response.data instanceof ArrayBuffer) {
        const buffer = Buffer.from(response.data);
        // Ignore small responses, likely errors or blank images
        if (buffer.length < 20) {
          return null;
        }
        const contentType = response.headers["content-type"] ?? "image/png";
        const dataUri = `data:${contentType};base64,${buffer.toString("base64")}`;
        return { dataUri, contentType };
      }

      if (typeof response.data === "string") {
        // If it's a string, it must be a data URI, otherwise we don't know how to handle it.
        if (response.data.startsWith("data:image")) {
          const contentType = response.headers["content-type"] ?? "image/png";
          return { dataUri: response.data, contentType };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private async canDomainBeProcessedAlready(
    domain: string,
  ): Promise<DomainProcessingState> {
    const now = Date.now();
    const lastFetchKey = `lastFetchTimestamp:${domain}`;
    const rateLimitKey = `rateLimitUntil:${domain}`;

    // 1. Short-circuit when the domain is explicitly rate-limited
    const rateLimitUntil = Number.parseInt(
      (await this.redis.get(rateLimitKey)) ?? "0",
      10,
    );
    if (now < rateLimitUntil) {
      logError(
        `Domain ${domain} is rate limited until ${new Date(rateLimitUntil).toISOString()}`,
      );
      return {
        canProcess: false,
        reason: `Rate limited until ${new Date(rateLimitUntil).toISOString()}`,
        waitUntil: rateLimitUntil,
      };
    }

    // 2. Use SETNX as a lightweight distributed mutex so that only one worker
    //    is allowed to fetch the domain within the configured delay window.
    const delaySetting = String(
      this.domainDelaySettings[domain] ?? this.defaultDelay,
    );

    // Attempt to set the mutex key with expiry in a single atomic operation.
    // Redis returns null when the NX condition fails.
    // The type signature on our Redis client mock does not include the "NX"
    // flag, so we cast to `unknown` to satisfy TypeScript while still sending
    // a valid command to the real server.
    const setResult = await (this.redis as unknown as RedisSetResult).set(
      lastFetchKey,
      now.toString(),
      "PX",
      Number.parseInt(delaySetting, 10),
      "NX",
    );
    if (setResult === null) {
      // Mutex hit – another process has fetched this domain recently.
      return {
        canProcess: false,
        reason: "Another process is currently processing this domain",
      };
    }

    return { canProcess: true };
  }
}

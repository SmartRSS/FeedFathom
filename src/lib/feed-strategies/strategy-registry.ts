import type { AxiosRequestConfig } from "axios";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import type { RedisClient } from "bun";
import type { RedisSetResult } from "../../types/feed-parser-types.ts";
import type {
  ParsedFeedInfo,
  ParsedFeedResult,
} from "../../types/parsed-feed-result.ts";
import { logError as error } from "../../util/log.ts";
import type { RedirectMap } from "../redirect-map.ts";
import { FacebookFeedStrategy } from "./facebook-feed-strategy.ts";
import type {
  FeedParserStrategy,
  RateLimitConfig,
} from "./feed-parser-strategy.ts";
import { FeedRequestHandler } from "./feed-request-handler.ts";
import { GenericFeedStrategy } from "./generic-feed-strategy.ts";
import { JsonFeedStrategy } from "./json-feed-strategy.ts";
import { StrategyDetectionService } from "./strategy-detection-service.ts";
import { WebSubFeedStrategy } from "./websub-feed-strategy.ts";

export interface FeedParserStrategyContext {
  axiosInstance: AxiosCacheInstance;
  redis: RedisClient;
  redirectMap: RedirectMap;
}

export class FeedParserStrategyRegistry {
  private strategies: FeedParserStrategy[];
  private detectionService: StrategyDetectionService;
  private requestHandler: FeedRequestHandler;

  constructor(private readonly context: FeedParserStrategyContext) {
    this.strategies = [
      new WebSubFeedStrategy(),
      new JsonFeedStrategy(),
      new FacebookFeedStrategy(),
      new GenericFeedStrategy(),
    ];

    this.detectionService = new StrategyDetectionService(this.strategies);
    this.requestHandler = new FeedRequestHandler(
      this.context.axiosInstance,
      this.context.redis,
      this.context.redirectMap,
    );
  }

  /**
   * Gets rate limit configuration for a strategy
   */
  getRateLimitConfig(strategyName: string): RateLimitConfig | undefined {
    const strategy = this.getStrategyByName(strategyName);
    return strategy?.getRateLimitConfig?.();
  }

  /**
   * Applies strategy-specific rate limiting
   */
  private async applyStrategyRateLimit(
    strategyName: string,
    domain: string,
  ): Promise<void> {
    const rateLimitConfig = this.getRateLimitConfig(strategyName);
    if (!rateLimitConfig) {
      return; // Use default rate limiting
    }

    const rlKey = `rateLimitUntil:${domain}:${strategyName}`;
    const now = Date.now();

    // Check if we're currently rate limited
    const currentLimit = await this.context.redis.get(rlKey);
    if (currentLimit) {
      const waitUntil = Number.parseInt(currentLimit, 10);
      if (now < waitUntil) {
        const waitTime = waitUntil - now;
        error(
          `Strategy ${strategyName} rate limited for ${domain}, waiting ${Math.round(waitTime / 1000)}s`,
        );
        throw new Error(
          `Rate limited by ${strategyName} strategy for ${domain}, retry after ${new Date(waitUntil).toISOString()}`,
        );
      }
    }

    // Calculate next rate limit window
    let delayMs = rateLimitConfig.minDelayMs;
    if (rateLimitConfig.randomize && rateLimitConfig.maxDelayMs) {
      delayMs = Math.floor(
        Math.random() *
          (rateLimitConfig.maxDelayMs - rateLimitConfig.minDelayMs) +
          rateLimitConfig.minDelayMs,
      );
    }

    const nextLimit = now + delayMs;
    const ttl = Math.max(1, delayMs);

    await (this.context.redis as unknown as RedisSetResult).set(
      rlKey,
      nextLimit.toString(),
      "PX",
      ttl,
      "NX",
    );

    error(
      `Applied ${strategyName} rate limit for ${domain}: ${Math.round(delayMs / 1000)}s delay`,
    );
  }

  async parseWithDetection(
    url: string,
    sourceId: number,
    originalUrl?: string,
    storedStrategy?: string,
    storedConfig?: string,
  ): Promise<{
    result: ParsedFeedResult;
    cached: boolean;
    finalUrl: string;
    permanentRedirect: boolean;
  }> {
    try {
      let strategyInfo: {
        strategy: string;
        config?: AxiosRequestConfig | undefined;
      };

      if (storedStrategy) {
        // Use stored strategy directly
        strategyInfo = {
          strategy: storedStrategy,
          config: storedConfig
            ? (JSON.parse(storedConfig) as AxiosRequestConfig)
            : undefined,
        };
      } else {
        // Fallback to detection for new sources
        const detectionResult = await this.detectionService.detectStrategy(url);
        strategyInfo = {
          strategy: detectionResult.strategy,
          config: detectionResult.config,
        };
      }

      // Apply strategy-specific rate limiting
      const domain = new URL(url).hostname;
      await this.applyStrategyRateLimit(strategyInfo.strategy, domain);

      // Fetch with strategy-specific config
      const { response, cached, finalUrl, permanentRedirect } =
        await this.requestHandler.fetch(url, strategyInfo.config);

      // Parse with detected strategy
      const strategy = this.getStrategyByName(strategyInfo.strategy);
      if (!strategy) {
        throw new Error(`Strategy ${strategyInfo.strategy} not found`);
      }

      const result = await strategy.parse({
        response,
        sourceId,
        ...(originalUrl !== undefined ? { originalUrl } : {}),
      });

      return {
        result,
        cached,
        finalUrl,
        permanentRedirect,
      };
    } catch (err) {
      await this.handleRateLimitError(err, url);
      throw err;
    }
  }

  async getInfoWithDetection(
    url: string,
    _originalUrl?: string,
    storedStrategy?: string,
    storedConfig?: string,
  ): Promise<{
    feedInfo: ParsedFeedInfo;
    cached: boolean;
    finalUrl: string;
    permanentRedirect: boolean;
    strategyType: string;
  }> {
    try {
      let strategyInfo: {
        strategy: string;
        config?: AxiosRequestConfig | undefined;
      };

      if (storedStrategy) {
        // Use stored strategy directly
        strategyInfo = {
          strategy: storedStrategy,
          config: storedConfig
            ? (JSON.parse(storedConfig) as AxiosRequestConfig)
            : undefined,
        };
      } else {
        // Fallback to detection for new sources
        const detectionResult = await this.detectionService.detectStrategy(url);
        strategyInfo = {
          strategy: detectionResult.strategy,
          config: detectionResult.config,
        };
      }

      // Apply strategy-specific rate limiting
      const domain = new URL(url).hostname;
      await this.applyStrategyRateLimit(strategyInfo.strategy, domain);

      // Fetch with strategy-specific config
      const { response, cached, finalUrl, permanentRedirect } =
        await this.requestHandler.fetch(url, strategyInfo.config);

      // Get info with detected strategy
      const strategy = this.getStrategyByName(strategyInfo.strategy);
      if (!strategy) {
        throw new Error(`Strategy ${strategyInfo.strategy} not found`);
      }

      const { feedInfo } = await strategy.getInfoOnly({ response });

      return {
        feedInfo,
        cached,
        finalUrl,
        permanentRedirect,
        strategyType: strategyInfo.strategy,
      };
    } catch (err) {
      await this.handleRateLimitError(err, url);
      throw err;
    }
  }

  /**
   * Gets strategy by name
   */
  private getStrategyByName(name: string): FeedParserStrategy | undefined {
    return this.strategies.find(
      (strategy) => strategy.constructor.name === name,
    );
  }

  /**
   * Gets the source type for a URL
   */
  getSourceType(url: string): "feed" | "newsletter" | "websub" {
    return this.detectionService.getSourceType(url);
  }

  /**
   * Detects strategy for a URL (for initial source creation)
   */
  async detectStrategyForUrl(url: string): Promise<{
    strategy: string;
    config?: string | undefined;
    sourceType: "feed" | "newsletter" | "websub";
  }> {
    const strategyInfo = await this.detectionService.detectStrategy(url);
    const sourceType = this.detectionService.getSourceType(url);

    return {
      strategy: strategyInfo.strategy,
      config: strategyInfo.config
        ? JSON.stringify(strategyInfo.config)
        : undefined,
      sourceType,
    };
  }

  private async handleRateLimitError(err: unknown, url: string): Promise<void> {
    if (err instanceof Error && "response" in err) {
      const response = (
        err as {
          response?: { status?: number; headers?: Record<string, string> };
        }
      ).response;
      if (response?.status === 429) {
        const domain = new URL(url).hostname;
        const retryAfter = response.headers?.["retry-after"];
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

        const rlKey = `rateLimitUntil:${domain}`;
        const ttl = Math.max(1, waitUntil - Date.now());
        await (this.context.redis as unknown as RedisSetResult).set(
          rlKey,
          waitUntil.toString(),
          "PX",
          ttl,
          "NX",
        );
        error(
          `Received 429 for ${url}, rate limiting domain ${domain} until ${new Date(waitUntil).toISOString()}`,
        );
        throw new Error(
          `Rate limited by ${domain}, retry after ${new Date(waitUntil).toISOString()}`,
        );
      }
    }
  }
}

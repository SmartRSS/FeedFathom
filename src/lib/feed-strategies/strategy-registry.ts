import type {
  AxiosCacheInstance,
  CacheAxiosResponse,
} from "axios-cache-interceptor";
import type { RedisClient } from "bun";
import type {
  ParseError,
  RedisSetResult,
} from "../../types/feed-parser-types.ts";
import type {
  ParsedFeedInfo,
  ParsedFeedResult,
} from "../../types/parsed-feed-result.ts";
import { logError as error } from "../../util/log.ts";
import type { RedirectMap } from "../redirect-map.ts";
import type { FeedParserStrategy } from "./feed-parser-strategy.ts";
import { GenericFeedStrategy } from "./generic-feed-strategy.ts";
import { JsonFeedStrategy } from "./json-feed-strategy.ts";

export interface FeedParserStrategyContext {
  axiosInstance: AxiosCacheInstance;
  redis: RedisClient;
  redirectMap: RedirectMap;
}

export class FeedParserStrategyRegistry {
  private strategies: FeedParserStrategy[];

  constructor(private readonly context: FeedParserStrategyContext) {
    this.strategies = [new JsonFeedStrategy(), new GenericFeedStrategy()];
  }

  async parseWithDetection(
    url: string,
    sourceId: number,
    originalUrl?: string,
  ): Promise<{
    result: ParsedFeedResult;
    cached: boolean;
    finalUrl: string;
    permanentRedirect: boolean;
  }> {
    try {
      const response = await this.context.axiosInstance.get(url, {
        responseType: "text",
        timeout: 30000,
      });

      // Handle rate limiting as a cross-cutting concern
      await this.handleRateLimiting(response, url);

      // Detect feed type and find appropriate strategy
      const result = await this.detectStrategyWithFallback(
        response.data,
        async (strategy) =>
          await Promise.resolve(
            strategy.parse({
              response,
              sourceId,
              ...(originalUrl !== undefined ? { originalUrl } : {}),
            }),
          ),
      );

      // Handle URL and redirect logic at registry level
      const finalUrl = this.getFinalUrl(response, url);
      const permanentRedirect = await this.handleRedirects(url, finalUrl);

      if (finalUrl !== url) {
        await this.context.redirectMap.setRedirect(url, finalUrl);
      }
      if (originalUrl && originalUrl !== finalUrl) {
        await this.context.redirectMap.setRedirect(originalUrl, finalUrl);
      }

      return {
        result,
        cached: response.cached ?? false,
        finalUrl,
        permanentRedirect,
      };
    } catch (err) {
      // Handle rate limit errors
      await this.handleRateLimitError(err, url);
      throw err;
    }
  }

  async getInfoWithDetection(
    url: string,
    originalUrl?: string,
  ): Promise<{
    feedInfo: ParsedFeedInfo;
    cached: boolean;
    finalUrl: string;
    permanentRedirect: boolean;
  }> {
    try {
      const response = await this.context.axiosInstance.get(url, {
        responseType: "text",
        timeout: 30000,
      });

      await this.handleRateLimiting(response, url);
      const { feedInfo } = await this.detectStrategyWithFallback(
        response.data,
        async (strategy) =>
          await Promise.resolve(strategy.getInfoOnly({ response })),
      );
      const finalUrl = this.getFinalUrl(response, url);
      const permanentRedirect = await this.handleRedirects(url, finalUrl);
      if (finalUrl !== url) {
        await this.context.redirectMap.setRedirect(url, finalUrl);
      }
      if (originalUrl && originalUrl !== finalUrl) {
        await this.context.redirectMap.setRedirect(originalUrl, finalUrl);
      }
      return {
        feedInfo,
        cached: response.cached ?? false,
        finalUrl,
        permanentRedirect,
      };
    } catch (err) {
      await this.handleRateLimitError(err, url);
      throw err;
    }
  }

  private async handleRateLimiting(
    response: CacheAxiosResponse<unknown>,
    url: string,
  ): Promise<void> {
    const domain = new URL(url).hostname;
    const normalizedHeaders = this.normalizeHeaders(response.headers);
    const rateLimitReset = normalizedHeaders["x-ratelimit-reset"];
    const rateLimitRemaining = normalizedHeaders["x-ratelimit-remaining"];

    if (rateLimitRemaining !== undefined && rateLimitReset !== undefined) {
      const remaining = Number(rateLimitRemaining);
      const reset = Number(rateLimitReset);
      if (!Number.isNaN(remaining) && remaining <= 1 && !Number.isNaN(reset)) {
        const waitUntil = reset * 1000;
        if (waitUntil > Date.now()) {
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
            `Upcoming rate limit for ${domain}, pausing requests until ${new Date(waitUntil).toISOString()}`,
          );
        }
      }
    }
  }

  private normalizeHeaders(headers: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        if (value === null || value === undefined) {
          continue;
        }
        if (typeof value === "string") {
          result[key] = value;
        } else if (Array.isArray(value)) {
          result[key] = value.join(", ");
        } else if (typeof value === "number") {
          result[key] = value.toString();
        } else if (typeof value === "boolean") {
          result[key] = value.toString();
        } else {
          result[key] = String(value);
        }
      }
    }
    return result;
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

  private async detectStrategyWithFallback<T>(
    data: string,
    tryParse: (strategy: FeedParserStrategy) => Promise<T>,
  ): Promise<T> {
    const candidates = this.strategies.filter((s) => s.canLikelyParse(data));
    if (candidates.length === 0) {
      const parseError: ParseError = new Error(
        "No suitable strategy found for feed",
      ) as ParseError;
      parseError.code = "PARSE_ERROR";
      parseError.strategy = "none";
      parseError.data = data.substring(0, 100); // First 100 chars for debugging
      throw parseError;
    }
    let lastError: ParseError | Error | unknown;
    for (const strategy of candidates) {
      try {
        return await tryParse(strategy);
      } catch (err) {
        lastError = err;
        // Try next
      }
    }
    throw lastError ?? new Error("All strategies failed to parse feed");
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
        const redirectCheck = await this.context.axiosInstance.get(fetchedUrl, {
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
}

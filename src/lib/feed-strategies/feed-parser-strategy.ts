import type { AxiosResponse } from "axios";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import type { RedisClient } from "bun";
import type { ParsedArticle } from "../../types/feed-parser-types.ts";
import type {
  ParsedFeedInfo,
  ParsedFeedResult,
} from "../../types/parsed-feed-result.ts";

export interface FeedParserStrategyContext {
  axiosInstance: AxiosCacheInstance;
  redis: RedisClient;
  redirectMap: {
    setRedirect(from: string, to: string): Promise<void>;
  };
}

export interface RateLimitConfig {
  /** Minimum delay between requests in milliseconds */
  minDelayMs: number;
  /** Maximum delay between requests in milliseconds (for randomization) */
  maxDelayMs?: number;
  /** Whether to randomize the delay between min and max */
  randomize?: boolean;
}

export interface FeedParserStrategy {
  /**
   * Get rate limiting configuration for this strategy
   * If not implemented, uses default rate limiting
   */
  getRateLimitConfig?(): RateLimitConfig;

  /**
   * Parse a feed from a given HTTP response
   *
   * @param params - The response and metadata
   * @returns Parsed feed data (feedInfo and articles only), sync or async
   */
  parse(params: {
    response: AxiosResponse<string>;
    sourceId: number;
    originalUrl?: string;
  }): ParsedFeedResult | Promise<ParsedFeedResult>;

  /**
   * Get only feed info from a given HTTP response (for preview scenarios)
   *
   * @param params - The response
   * @returns Only the feed info, sync or async
   */
  getInfoOnly(params: {
    response: AxiosResponse<string>;
  }): { feedInfo: ParsedFeedInfo } | Promise<{ feedInfo: ParsedFeedInfo }>;

  /**
   * Get only articles from a given HTTP response
   *
   * @param params - The response and sourceId
   * @returns Only the articles, sync or async
   */
  getArticlesOnly(params: {
    response: AxiosResponse<string>;
    sourceId: number;
  }): { articles: ParsedArticle[] } | Promise<{ articles: ParsedArticle[] }>;
}

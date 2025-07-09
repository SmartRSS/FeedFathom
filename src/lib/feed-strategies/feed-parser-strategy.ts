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

export interface FeedParserStrategy {
  /**
   * Check if this strategy can likely parse the given response data
   *
   * @param data - The response data to check
   * @returns True if this strategy can likely parse the data, false otherwise
   */
  canLikelyParse(data: string): boolean;

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

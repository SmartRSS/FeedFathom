import type { AxiosResponse } from "axios";

// Error types for better error handling
export interface FeedParserError extends Error {
  code?: string;
  cause?: unknown;
  response?: {
    status?: number;
    data?: unknown;
    headers?: Record<string, string>;
  };
}

export interface RateLimitError extends FeedParserError {
  code: "RATE_LIMIT";
  retryAfter?: number;
  waitUntil: number;
}

export interface NetworkError extends FeedParserError {
  code: "NETWORK_ERROR";
  url: string;
}

export interface ParseError extends FeedParserError {
  code: "PARSE_ERROR";
  strategy: string;
  data: string;
}

// Rate limiting types
export interface RateLimitHeaders {
  "x-ratelimit-reset"?: string;
  "x-ratelimit-remaining"?: string;
  "retry-after"?: string;
}

export interface RateLimitInfo {
  remaining: number;
  reset: number;
  retryAfter?: number;
}

// Redis operation types
export interface RedisSetOptions {
  key: string;
  value: string;
  px: "PX";
  ttl: number;
  nx: "NX";
}

export interface RedisSetResult {
  set(
    key: string,
    value: string,
    px: "PX",
    ttl: number,
    nx: "NX",
  ): Promise<"OK" | null>;
}

// Feed parsing result types
export interface ParsedArticle {
  guid: string;
  sourceId: number;
  title: string;
  url: string;
  author: string;
  publishedAt: Date;
  content: string;
  updatedAt: Date;
  lastSeenInFeedAt: Date;
}

export interface ParsedFeedInfo {
  title: string;
  description?: string;
  link: string;
  language?: string;
  image?: string;
}

export interface ParsedFeedResult {
  feedInfo: ParsedFeedInfo;
  articles: ParsedArticle[];
}

// Strategy detection types
export interface StrategyDetectionResult<T> {
  success: true;
  data: T;
  strategy: string;
}

export interface StrategyDetectionError {
  success: false;
  error: ParseError;
  strategy: string;
}

export type StrategyDetectionOutcome<T> =
  | StrategyDetectionResult<T>
  | StrategyDetectionError;

// Domain processing types
export interface DomainProcessingState {
  canProcess: boolean;
  reason?: string;
  waitUntil?: number;
}

export interface DomainRateLimitInfo {
  domain: string;
  waitUntil: number;
  ttl: number;
}

// Favicon types
export interface FaviconResponse {
  status: number;
  data: ArrayBuffer | string;
  headers: {
    "content-type"?: string;
  };
}

export interface FaviconPayload {
  dataUri: string;
  contentType: string;
}

// Error context types
export interface ErrorContext {
  url: string;
  sourceId?: number;
  strategy?: string;
  timestamp: Date;
  userAgent?: string;
}

// Validation types
export interface FeedValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  contentType?: string;
  encoding?: string;
}

// Cache types
export interface CacheInfo {
  cached: boolean;
  cacheKey?: string;
  ttl?: number;
  stale?: boolean;
}

// Redirect types
export interface RedirectInfo {
  from: string;
  to: string;
  permanent: boolean;
  statusCode?: number;
}

// Type guards
export function isFeedParserError(error: unknown): error is FeedParserError {
  return error instanceof Error && "code" in error;
}

export function isRateLimitError(error: unknown): error is RateLimitError {
  return isFeedParserError(error) && error.code === "RATE_LIMIT";
}

export function isNetworkError(error: unknown): error is NetworkError {
  return isFeedParserError(error) && error.code === "NETWORK_ERROR";
}

export function isParseError(error: unknown): error is ParseError {
  return isFeedParserError(error) && error.code === "PARSE_ERROR";
}

export function isValidHttpResponse(
  response: unknown,
): response is AxiosResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    "status" in response &&
    "data" in response &&
    "headers" in response
  );
}

// Utility types for better type safety
export type NonNullableFields<T> = {
  [P in keyof T]: NonNullable<T[P]>;
};

export type PartialWithRequired<T, K extends keyof T> = Partial<T> & Pick<T, K>;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

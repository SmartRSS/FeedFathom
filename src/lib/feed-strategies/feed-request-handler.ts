import type { AxiosRequestConfig } from "axios";
import type {
  AxiosCacheInstance,
  CacheAxiosResponse,
} from "axios-cache-interceptor";
import type { RedisClient } from "bun";
import type { RedirectMap } from "../redirect-map.ts";

export interface FeedRequestResult {
  response: CacheAxiosResponse<string>;
  cached: boolean;
  finalUrl: string;
  permanentRedirect: boolean;
}

export class FeedRequestHandler {
  constructor(
    private readonly axiosInstance: AxiosCacheInstance,
    private readonly redis: RedisClient,
    private readonly redirectMap: RedirectMap,
  ) {}

  /**
   * Fetches content from a URL with optional custom configuration
   */
  async fetch(
    url: string,
    config?: AxiosRequestConfig,
  ): Promise<FeedRequestResult> {
    try {
      const response = await this.axiosInstance.get(url, {
        responseType: "text",
        timeout: 30000,
        ...config,
      });

      // Handle rate limiting
      await this.handleRateLimiting(response, url);

      // Handle redirects
      const finalUrl = this.getFinalUrl(response, url);
      const permanentRedirect = await this.handleRedirects(url, finalUrl);

      // Store redirect mapping
      if (finalUrl !== url) {
        await this.redirectMap.setRedirect(url, finalUrl);
      }

      return {
        response,
        cached: response.cached ?? false,
        finalUrl,
        permanentRedirect,
      };
    } catch (err) {
      await this.handleRateLimitError(err, url);
      throw err;
    }
  }

  /**
   * Handles rate limiting by checking response headers
   */
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
          await this.redis.set(
            rlKey,
            waitUntil.toString(),
            "PX",
            ttl.toString(),
            "NX",
          );
          console.error(
            `Upcoming rate limit for ${domain}, pausing requests until ${new Date(waitUntil).toISOString()}`,
          );
        }
      }
    }
  }

  /**
   * Handles rate limit errors
   */
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
        await this.redis.set(
          rlKey,
          waitUntil.toString(),
          "PX",
          ttl.toString(),
          "NX",
        );
        console.error(
          `Received 429 for ${url}, rate limiting domain ${domain} until ${new Date(waitUntil).toISOString()}`,
        );
        throw new Error(
          `Rate limited by ${domain}, retry after ${new Date(waitUntil).toISOString()}`,
        );
      }
    }
  }

  /**
   * Normalizes headers for consistent access
   */
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

  /**
   * Gets the final URL after redirects
   */
  private getFinalUrl(
    response: {
      request?: { res?: { responseUrl?: string } };
      config: { url?: string };
    },
    fetchedUrl: string,
  ): string {
    return (
      response.request?.res?.responseUrl ?? response.config.url ?? fetchedUrl
    );
  }

  /**
   * Handles redirects and determines if they're permanent
   */
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
}

import type { RedisClient } from "bun";
import { logError as error_ } from "../util/log.ts";

export class RedirectMap {
  private readonly redisKeyPrefix = "redirect_map:";
  private readonly ttl = 24 * 60 * 60 * 1000; // 24 hours

  constructor(private readonly redis: RedisClient) {}

  /**
   * Store a redirect mapping from old URL to new URL
   */
  async setRedirect(oldUrl: string, newUrl: string): Promise<void> {
    try {
      const key = `${this.redisKeyPrefix}${this.normalizeUrl(oldUrl)}`;
      await this.redis.set(key, newUrl, "PX", this.ttl);
      error_(`Redirect map: ${oldUrl} -> ${newUrl}`);
    } catch (error) {
      error_("Failed to set redirect map:", error);
    }
  }

  /**
   * Get the redirect URL for a given URL, if it exists
   */
  async getRedirect(url: string): Promise<string | null> {
    try {
      const key = `${this.redisKeyPrefix}${this.normalizeUrl(url)}`;
      const redirectUrl = await this.redis.get(key);
      return redirectUrl;
    } catch (error) {
      error_("Failed to get redirect map:", error);
      return null;
    }
  }

  /**
   * Check if a URL should be redirected and return the new URL if so
   */
  async resolveUrl(url: string): Promise<string> {
    const redirectUrl = await this.getRedirect(url);
    return redirectUrl ?? url;
  }

  /**
   * Remove a redirect mapping
   */
  async removeRedirect(url: string): Promise<void> {
    try {
      const key = `${this.redisKeyPrefix}${this.normalizeUrl(url)}`;
      await this.redis.del(key);
    } catch (error) {
      error_("Failed to remove redirect map:", error);
    }
  }

  /**
   * Normalize URL for consistent key generation
   */
  private normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // Remove trailing slash for consistency
      return urlObj.href.replace(/\/$/, "");
    } catch {
      // If URL parsing fails, return as-is
      return url;
    }
  }

  /**
   * Get all redirect mappings (for debugging/admin purposes)
   */
  async getAllRedirects(): Promise<Record<string, string>> {
    try {
      const keys = await this.redis.keys(`${this.redisKeyPrefix}*`);
      const redirects: Record<string, string> = {};

      for (const key of keys) {
        const oldUrl = key.replace(this.redisKeyPrefix, "");
        const newUrl = await this.redis.get(key);
        if (newUrl) {
          redirects[oldUrl] = newUrl;
        }
      }

      return redirects;
    } catch (error) {
      error_("Failed to get all redirects:", error);
      return {};
    }
  }
}

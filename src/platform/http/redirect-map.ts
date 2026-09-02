type RedirectRedis = {
  del(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  keys(pattern: string): Promise<string[]>;
  set(
    key: string,
    value: string,
    expiration: "PX",
    milliseconds: number,
  ): Promise<unknown>;
};

export class RedirectMap {
  private readonly redisKeyPrefix = "redirect_map:";
  private readonly ttl = 24 * 60 * 60 * 1000; // 24 hours

  constructor(private readonly redis: RedirectRedis) {}

  /**
   * Store a redirect mapping from old URL to new URL
   */
  async setRedirect(oldUrl: string, newUrl: string): Promise<void> {
    try {
      const key = `${this.redisKeyPrefix}${this.normalizeUrl(oldUrl)}`;
      await this.redis.set(key, newUrl, "PX", this.ttl);
      console.error(`Redirect map: ${oldUrl} -> ${newUrl}`);
    } catch (error) {
      console.error("Failed to set redirect map:", error);
    }
  }

  async getRedirect(url: string): Promise<string | null> {
    try {
      const key = `${this.redisKeyPrefix}${this.normalizeUrl(url)}`;
      const redirectUrl = await this.redis.get(key);
      return redirectUrl;
    } catch (error) {
      console.error("Failed to get redirect map:", error);
      return null;
    }
  }

  async resolveUrl(url: string): Promise<string> {
    const redirectUrl = await this.getRedirect(url);
    return redirectUrl ?? url;
  }

  async removeRedirect(url: string): Promise<void> {
    try {
      const key = `${this.redisKeyPrefix}${this.normalizeUrl(url)}`;
      await this.redis.del(key);
    } catch (error) {
      console.error("Failed to remove redirect map:", error);
    }
  }

  private normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.href.replace(/\/$/, "");
    } catch {
      return url;
    }
  }

  /** For the admin view. */
  async getAllRedirects(): Promise<Record<string, string>> {
    try {
      const keys = await this.redis.keys(`${this.redisKeyPrefix}*`);
      const entries = await Promise.all(
        keys.map(async (key) => ({
          newUrl: await this.redis.get(key),
          oldUrl: key.replace(this.redisKeyPrefix, ""),
        })),
      );
      const redirects: Record<string, string> = {};
      for (const { newUrl, oldUrl } of entries)
        if (newUrl) redirects[oldUrl] = newUrl;

      return redirects;
    } catch (error) {
      console.error("Failed to get all redirects:", error);
      return {};
    }
  }
}

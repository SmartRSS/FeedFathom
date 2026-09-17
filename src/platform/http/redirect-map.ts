// One SCAN page. Redis caps how long a single page takes, which is the whole
// reason to prefer it to KEYS here.
const scanPageHint = 500;

type RedirectRedis = {
  del(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  scan(
    cursor: string,
    match: "MATCH",
    pattern: string,
    count: "COUNT",
    hint: number,
  ): Promise<[string, string[]]>;
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
      console.log(`Redirect map: ${oldUrl} -> ${newUrl}`);
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

  /**
   * For the admin view.
   *
   * SCAN still walks the whole keyspace, but lets Redis serve the job queue
   * and HTTP cache between pages. KEYS blocks them for the entire walk.
   * The map absorbs duplicate keys. Concurrent additions can be missed,
   * which is acceptable for an admin listing of a cache with a one-day TTL.
   */
  async getAllRedirects(): Promise<Record<string, string>> {
    try {
      const redirects: Record<string, string> = {};
      let cursor = "0";
      do {
        /* eslint-disable no-await-in-loop -- Each page's cursor comes from the last. */
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          `${this.redisKeyPrefix}*`,
          "COUNT",
          scanPageHint,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          const values = await this.redis.mget(...keys);
          for (const [index, key] of keys.entries()) {
            const newUrl = values[index];
            if (newUrl)
              redirects[key.slice(this.redisKeyPrefix.length)] = newUrl;
          }
        }
        /* eslint-enable no-await-in-loop */
      } while (cursor !== "0");
      return redirects;
    } catch (error) {
      console.error("Failed to get all redirects:", error);
      return {};
    }
  }
}

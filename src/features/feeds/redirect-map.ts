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
  private readonly ttl = 24 * 60 * 60 * 1000;

  constructor(private readonly redis: RedirectRedis) {}

  async setRedirect(oldUrl: string, newUrl: string): Promise<void> {
    const key = `${this.redisKeyPrefix}${this.normalizeUrl(oldUrl)}`;
    await this.redis.set(key, newUrl, "PX", this.ttl);
    console.log(`Redirect map: ${oldUrl} -> ${newUrl}`);
  }

  async resolveUrl(url: string): Promise<string> {
    return (
      (await this.redis.get(
        `${this.redisKeyPrefix}${this.normalizeUrl(url)}`,
      )) ?? url
    );
  }

  async removeRedirect(url: string): Promise<void> {
    await this.redis.del(`${this.redisKeyPrefix}${this.normalizeUrl(url)}`);
  }

  private normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.href.replace(/\/$/, "");
    } catch {
      return url;
    }
  }

  async getAllRedirects(): Promise<Record<string, string>> {
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
          if (newUrl) redirects[key.slice(this.redisKeyPrefix.length)] = newUrl;
        }
      }
      /* eslint-enable no-await-in-loop */
    } while (cursor !== "0");
    return redirects;
  }
}

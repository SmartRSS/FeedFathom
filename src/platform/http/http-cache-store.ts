import {
  type CachedResponse,
  cachedResponseCheck,
} from "#platform/http/http-cache-policy.ts";
import {
  HttpDeadlineError,
  type RequestDeadline,
} from "#platform/http/request-deadline.ts";
import { parseHttpUrl } from "#platform/http/http-native-transport.ts";

export type HttpRedis = {
  decr(key: string): Promise<number>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  get(key: string): Promise<null | string>;
  incr(key: string): Promise<number>;
  send?(command: string, args: string[]): Promise<unknown>;
  set(
    key: string,
    value: string,
    ...options: Array<number | string>
  ): Promise<null | string>;
};

const cachePrefix = "http-cache:";
const cacheLockPrefix = "http-cache-lock:";
const cacheRetentionMs = 7 * 24 * 60 * 60_000;
// Sized off the largest feed actually polled, not a round number: Project
// Zero inlines full exploit writeups (12.6 MiB, +1.3 MiB per post). The rest
// of a 227-source corpus fits under 1 MiB.
//
// ponytail: one global ceiling, not a per-source budget. Worst case is
// WORKER_CONCURRENCY downloads all at the cap against the worker's memory
// limit (50 and 750 MiB in production), which only works because a single
// source exceeds 5 MiB. Add per-source budgets if a second heavyweight shows
// up.
export const maximumBodyBytes = 24 * 1024 * 1024;
export const maximumBodyMebibytes = maximumBodyBytes / (1024 * 1024);
const maximumBase64Characters = Math.ceil(maximumBodyBytes / 3) * 4;
const maximumCacheWireCharacters = maximumBase64Characters + 64 * 1024;

const releaseCacheLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/u;

function isBoundedBase64(value: string): boolean {
  return (
    value.length <= maximumBase64Characters &&
    value.length % 4 === 0 &&
    decodedBase64Length(value) <= maximumBodyBytes &&
    base64Pattern.test(value)
  );
}

function decodedBase64Length(value: string): number {
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

// The Redis side of the HTTP cache: the base64 wire format, the wire-size
// cap, and the lock that keeps one fetch per URL at a time.
export class HttpCacheStore {
  constructor(
    private readonly redis: HttpRedis,
    private readonly deadlineMs: number,
  ) {}

  async acquireCacheLock(
    url: string,
    deadline: RequestDeadline,
  ): Promise<{ key: string; token: string }> {
    if (!this.redis.send) return { key: "", token: "" };
    const key = `${cacheLockPrefix}${this.cacheKey(url)}`;
    const token = Bun.randomUUIDv7();
    /* eslint-disable no-await-in-loop -- The lock must be acquired before the cache is read. */
    for (;;) {
      const acquired = await deadline.run(
        this.redis.set(
          key,
          token,
          "PX",
          (this.deadlineMs + 5_000).toString(),
          "NX",
        ),
      );
      if (acquired === "OK") return { key, token };
      await deadline.sleep(25);
    }
    /* eslint-enable no-await-in-loop */
  }

  async releaseCacheLock(
    lock: { key: string; token: string },
    deadline: RequestDeadline,
  ): Promise<void> {
    try {
      if (!lock.key || !this.redis.send) return;
      await deadline.run(
        this.redis.send("EVAL", [
          releaseCacheLockScript,
          "1",
          lock.key,
          lock.token,
        ]),
      );
    } catch {
      // The lock expires shortly after the request deadline.
    }
  }

  async getCached(
    url: string,
    deadline: RequestDeadline,
  ): Promise<CachedResponse | undefined> {
    const key = `${cachePrefix}${this.cacheKey(url)}`;
    const value = await deadline.run(this.redis.get(key));
    if (!value) return undefined;
    if (Buffer.byteLength(value) > maximumCacheWireCharacters) {
      await deadline.run(this.redis.del(key));
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (!cachedResponseCheck.Check(parsed) || !isBoundedBase64(parsed.body)) {
        await deadline.run(this.redis.del(key));
        return undefined;
      }
      parseHttpUrl(parsed.url);
      return parsed;
    } catch (error) {
      if (error instanceof HttpDeadlineError) throw error;
      await deadline.run(this.redis.del(key));
      return undefined;
    }
  }

  async saveCached(
    url: string,
    response: CachedResponse,
    deadline: RequestDeadline,
  ): Promise<void> {
    const key = `${cachePrefix}${this.cacheKey(url)}`;
    const value = JSON.stringify(response);
    if (Buffer.byteLength(value) > maximumCacheWireCharacters) {
      await deadline.run(this.redis.del(key));
      return;
    }
    await deadline.run(
      this.redis.set(
        key,
        value,
        "PX",
        Math.max(cacheRetentionMs, response.expiresAt - Date.now()),
      ),
    );
  }

  async delete(url: string, deadline: RequestDeadline): Promise<void> {
    await deadline.run(this.redis.del(`${cachePrefix}${this.cacheKey(url)}`));
  }

  private cacheKey(url: string): string {
    return Buffer.from(url).toString("base64url");
  }
}

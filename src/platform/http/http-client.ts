import {
  cacheable,
  type CachedResponse,
  cachedResponseCheck,
  refresh,
  sharedCacheAllowed,
} from "#platform/http/http-cache-policy.ts";
import {
  HttpDeadlineError,
  RequestDeadline,
} from "#platform/http/request-deadline.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { HttpRateLimiter } from "#platform/http/http-rate-limiter.ts";
import {
  HttpPolicyError,
  type NativeHttpResponse,
  type NativeHttpTransport,
  nativeHttpTransport,
  parseHttpUrl,
} from "#platform/http/http-native-transport.ts";

const cachePrefix = "http-cache:";
const cacheLockPrefix = "http-cache-lock:";
const cacheRetentionMs = 7 * 24 * 60 * 60_000;
const requestDeadlineMs = 30_000;
// Sized off the largest feed actually polled, not a round number: Project
// Zero inlines full exploit writeups (12.6 MiB, +1.3 MiB per post). The rest
// of a 227-source corpus fits under 1 MiB.
//
// ponytail: one global ceiling, not a per-source budget. Worst case is
// WORKER_CONCURRENCY downloads all at the cap against the worker's memory
// limit (50 and 750 MiB in production), which only works because a single
// source exceeds 5 MiB. Add per-source budgets if a second heavyweight shows
// up.
const maximumBodyBytes = 24 * 1024 * 1024;
const maximumBodyMebibytes = maximumBodyBytes / (1024 * 1024);
const maximumBase64Characters = Math.ceil(maximumBodyBytes / 3) * 4;
const maximumCacheWireCharacters = maximumBase64Characters + 64 * 1024;
const userAgentProduct = "SmartRSS/FeedFathom";
const userAgentUrl = "+https://github.com/SmartRSS/FeedFathom";
const shortShaLength = 7;

// Both fields land in an outgoing header, so anything outside this set is
// dropped rather than escaped. It covers hostnames with an optional :port and
// every tag shape produced here, and excludes the ";" / ")" / CR / LF that
// would let a mis-set env var break the header. Empty is treated as absent.
function sanitizeIdentity(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replaceAll(/[^\w.:-]/gu, "");
  if (cleaned === undefined || cleaned === "") return undefined;
  return cleaned;
}

// FEEDFATHOM_TAG is usually a full commit SHA; 7 characters identify the build
// just as well. Anything shorter (a channel tag, a semver) passes through.
function normalizeVersion(value: string | undefined): string | undefined {
  const tag = sanitizeIdentity(value);
  if (tag === undefined) return undefined;
  return /^[0-9a-f]{40}$/u.test(tag) ? tag.slice(0, shortShaLength) : tag;
}

// Feed readers report their subscriber count in the User-Agent -- often the
// only audience feedback RSS gives a publisher. Google's Feedfetcher set the
// shape ("...; 4 subscribers; feed-id=...") and Feedly, Feedbin and Inoreader
// copied it, so publishers scrape the literal word "subscribers".
//
// The build tag and instance host ride along so two FeedFathom instances can
// be told apart. The "+" slot keeps the project URL, not the instance host: a
// self-hosted domain explains nothing to the publisher reading it.
function buildUserAgentPrefix(identity: HttpClientIdentity): string {
  const version = normalizeVersion(identity.version);
  const product = version ? `${userAgentProduct}/${version}` : userAgentProduct;
  const instance = sanitizeIdentity(identity.instance) ?? "localhost";
  return `${product} (${userAgentUrl}; instance=${instance}`;
}

// Only appended when a real count is known -- discovery and preview fetches
// have no subscribers, and claiming otherwise poisons the numbers this exists
// to report. Plural even at one, because the regexes match the literal word.
function buildUserAgent(
  prefix: string,
  subscribers: number | undefined,
): string {
  if (
    subscribers === undefined ||
    !Number.isInteger(subscribers) ||
    subscribers < 0
  ) {
    return `${prefix})`;
  }
  return `${prefix}; ${subscribers} subscribers)`;
}

const releaseCacheLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const retryableStatuses = new Set([408, 425, 500, 502, 503, 504]);
const rateLimitedStatus = 429;
const notModifiedStatus = 304;

type HttpRedis = {
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

type HttpRequestOptions = {
  priority?: "background" | "interactive";
  responseType?: "arrayBuffer";
  // Skips the local TTL short-circuit but keeps conditional revalidation, so
  // an unchanged origin still answers 304 cheaply. For callers (a WebSub push)
  // that already know something changed.
  skipCache?: boolean;
  // Number of our users subscribed to the feed being fetched, reported to
  // the origin in the User-Agent (see buildUserAgent). Omitted for fetches
  // that aren't on behalf of subscribers: discovery, preview, favicons.
  subscribers?: number;
};

type ArrayBufferRequestOptions = HttpRequestOptions & {
  responseType: "arrayBuffer";
};

type HttpClientIdentity = {
  // FEED_FATHOM_DOMAIN. Falls back to "localhost" when unset.
  instance?: string | undefined;
  // FEEDFATHOM_BUILD: the commit baked into the image. Omitted from the
  // User-Agent when unset rather than guessed from the pulled tag.
  version?: string | undefined;
};

type HttpClientOptions = HttpClientIdentity & {
  deadlineMs?: number;
  // The per-host politeness interval. Only set by tests, which cannot afford
  // to sit out the real one; see HttpRateLimiter for the production value.
  intervalMs?: number;
  transport?: NativeHttpTransport;
};

type FetchResult = {
  permanent: boolean;
  response: NativeHttpResponse;
};

export type HttpResponse<T> = {
  cached: boolean;
  data: T;
  freshUntil?: number | null;
  headers: Headers;
  redirectedPermanently: boolean;
  status: number;
  url: string;
};

export class HttpClient {
  private readonly deadlineMs: number;
  private readonly transport: NativeHttpTransport;
  // Identity is fixed for the process; only the subscriber clause varies.
  private readonly userAgentPrefix: string;
  private readonly rateLimiter: HttpRateLimiter;

  constructor(
    private readonly redis: HttpRedis,
    options: HttpClientOptions = {},
  ) {
    this.rateLimiter = new HttpRateLimiter(redis, options.intervalMs);
    this.deadlineMs = options.deadlineMs ?? requestDeadlineMs;
    this.transport = options.transport ?? nativeHttpTransport;
    this.userAgentPrefix = buildUserAgentPrefix(options);
  }

  async get(
    url: string,
    options: ArrayBufferRequestOptions,
  ): Promise<HttpResponse<ArrayBuffer>>;
  async get(
    url: string,
    options?: HttpRequestOptions,
  ): Promise<HttpResponse<string>>;
  async get(
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<ArrayBuffer | string>> {
    const deadline = new RequestDeadline(this.deadlineMs);
    try {
      return await this.getBeforeDeadline(url, options, deadline);
    } finally {
      deadline.dispose();
    }
  }

  private async getBeforeDeadline(
    url: string,
    options: HttpRequestOptions,
    deadline: RequestDeadline,
  ): Promise<HttpResponse<ArrayBuffer | string>> {
    const lock = await this.acquireCacheLock(url, deadline);
    try {
      return await this.getWhileCacheLocked(url, options, deadline);
    } finally {
      await this.releaseCacheLock(lock, deadline);
    }
  }

  private async getWhileCacheLocked(
    url: string,
    options: HttpRequestOptions,
    deadline: RequestDeadline,
  ): Promise<HttpResponse<ArrayBuffer | string>> {
    const parsedUrl = parseHttpUrl(url);
    const cached = await this.getCached(url, deadline);
    if (cached && cached.expiresAt > Date.now() && !options.skipCache) {
      const response = this.fromCached(cached, options);
      deadline.assertActive();
      return response;
    }

    const hostname = parsedUrl.hostname;
    const headers = new Headers();
    headers.set(
      "accept",
      "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*",
    );
    headers.set(
      "user-agent",
      buildUserAgent(this.userAgentPrefix, options.subscribers),
    );
    if (cached) {
      const cachedHeaders = new Headers(cached.headers);
      const etag = cachedHeaders.get("etag");
      const lastModified = cachedHeaders.get("last-modified");
      if (etag) headers.set("if-none-match", etag);
      if (lastModified) headers.set("if-modified-since", lastModified);
    }

    const { permanent, response } = await this.fetchWithRetry(
      url,
      headers,
      hostname,
      options.priority ?? "interactive",
      deadline,
    );
    if (response.status === notModifiedStatus && cached) {
      response.destroy();
      const refreshed = refresh(cached, response.headers);
      const refreshedHeaders = new Headers(refreshed.headers);
      const retain = sharedCacheAllowed(refreshedHeaders);
      if (retain) await this.saveCached(url, refreshed, deadline);
      else
        await deadline.run(
          this.redis.del(`${cachePrefix}${this.cacheKey(url)}`),
        );
      const result = this.fromCached(
        retain ? refreshed : { ...refreshed, expiresAt: Date.now() },
        options,
      );
      deadline.assertActive();
      return result;
    }

    const body = await this.readBody(response, deadline);
    const next = cacheable(response, body, url);
    if (next) await this.saveCached(url, next, deadline);
    else {
      await deadline.run(this.redis.del(`${cachePrefix}${this.cacheKey(url)}`));
    }

    const data = this.decodeBody(body, options);
    deadline.assertActive();
    return {
      cached: false,
      data,
      freshUntil: next && next.expiresAt > Date.now() ? next.expiresAt : null,
      headers: response.headers,
      redirectedPermanently: permanent,
      status: response.status,
      url: response.url,
    };
  }

  private async fetchWithRetry(
    url: string,
    headers: Headers,
    hostname: string,
    priority: "background" | "interactive",
    deadline: RequestDeadline,
  ): Promise<FetchResult> {
    /* eslint-disable no-await-in-loop -- Each retry depends on its response and on re-reserving the host. */
    for (let attempt = 0; ; attempt++) {
      let result: FetchResult | undefined;
      try {
        result = await this.fetchFollowingRedirects(
          url,
          headers,
          priority,
          deadline,
        );
        // Whatever answered is what gets held back, which after a redirect
        // is not the host the request started at.
        const answeringHost = hostnameOf(result.response.url) ?? hostname;
        await this.rateLimiter.applyRateLimitHeaders(
          answeringHost,
          result.response.headers,
          deadline,
        );
        const retryAfter = result.response.headers.get("retry-after");
        // Retry-After is not a 429 header (RFC 9110 10.2.3): a 503 carrying
        // it is an origin saying when to come back, not a transient failure
        // to try again. Redirects carry it too, but they never reach here --
        // fetchFollowingRedirects consumes them -- so this is bounded to
        // error statuses.
        if (
          result.response.status === rateLimitedStatus ||
          (retryAfter !== null && result.response.status >= 400)
        ) {
          result.response.destroy();
          result = undefined;
          throw new HttpDeferredError(
            await this.rateLimiter.block(answeringHost, retryAfter, deadline),
          );
        }
        if (
          priority === "background" ||
          !this.isRetryable(result.response.status) ||
          attempt === 2
        ) {
          return result;
        }
        result.response.destroy();
      } catch (error) {
        result?.response.destroy(error instanceof Error ? error : undefined);
        if (
          error instanceof HttpDeferredError ||
          error instanceof HttpPolicyError ||
          error instanceof HttpDeadlineError ||
          deadline.controller.signal.aborted ||
          priority === "background" ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }
    /* eslint-enable no-await-in-loop */
  }

  private async fetchFollowingRedirects(
    url: string,
    headers: Headers,
    priority: "background" | "interactive",
    deadline: RequestDeadline,
  ): Promise<FetchResult> {
    let next = url;
    // A chain is permanent only if every hop is (301/308) -- one temporary hop
    // means the resolved URL could still change back.
    let permanent = true;
    /* eslint-disable no-await-in-loop -- Each redirect target comes from the previous response, and each is reserved on its own. */
    for (let redirects = 0; redirects <= 5; redirects++) {
      // A hop is a request like any other, and it is a request to a host of
      // its own. Reserving here rather than once per call is also what gives
      // a retry its interval, since every attempt re-enters this loop. The
      // hostname is safe to read: the first is already validated and every
      // later one was built by `new URL` below.
      await this.rateLimiter.reserve(
        new URL(next).hostname,
        priority,
        deadline,
      );
      const response = await deadline.run(
        this.transport(next, headers, deadline.controller.signal),
      );
      if (!redirectStatuses.has(response.status)) {
        return { permanent: redirects > 0 && permanent, response };
      }

      if (response.status !== 301 && response.status !== 308) {
        permanent = false;
      }
      const location = response.headers.get("location");
      response.destroy();
      if (!location) {
        throw new HttpPolicyError("Redirect response is missing Location");
      }
      try {
        next = new URL(location, next).toString();
      } catch {
        throw new HttpPolicyError("Redirect Location is malformed");
      }
    }
    /* eslint-enable no-await-in-loop */
    throw new HttpPolicyError("Too many redirects");
  }

  private async acquireCacheLock(
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

  private async releaseCacheLock(
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

  private async getCached(
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

  private async saveCached(
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

  private cacheKey(url: string): string {
    return Buffer.from(url).toString("base64url");
  }

  private fromCached(
    response: CachedResponse,
    options: HttpRequestOptions,
  ): HttpResponse<ArrayBuffer | string> {
    const body = Buffer.from(response.body, "base64");
    return {
      cached: true,
      data: this.decodeBody(body, options),
      freshUntil: response.expiresAt > Date.now() ? response.expiresAt : null,
      headers: new Headers(response.headers),
      // A cache hit is not a fresh redirect decision; the original fetch
      // already persisted any permanent redirect.
      redirectedPermanently: false,
      status: response.status,
      url: response.url,
    };
  }

  private async readBody(
    response: NativeHttpResponse,
    deadline: RequestDeadline,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      await deadline.run(
        (async () => {
          for await (const value of response.body) {
            if (typeof value !== "string" && !(value instanceof Uint8Array)) {
              throw new HttpPolicyError(
                "Response body emitted an invalid chunk",
              );
            }
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            length += chunk.byteLength;
            if (length > maximumBodyBytes) {
              throw new HttpPolicyError(
                `Decoded response body exceeds ${maximumBodyMebibytes.toString()} MiB`,
              );
            }
            chunks.push(chunk);
          }
        })(),
      );
      const body = Buffer.concat(chunks, length);
      deadline.assertActive();
      return body;
    } catch (error) {
      response.destroy(error instanceof Error ? error : undefined);
      throw error;
    }
  }

  private decodeBody(
    body: Buffer,
    options: HttpRequestOptions,
  ): ArrayBuffer | string {
    return options.responseType === "arrayBuffer"
      ? Uint8Array.from(body).buffer
      : body.toString();
  }

  private isRetryable(status: number): boolean {
    return retryableStatuses.has(status);
  }
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

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

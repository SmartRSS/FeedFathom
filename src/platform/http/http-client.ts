import {
  cacheable,
  type CachedResponse,
  refresh,
  sharedCacheAllowed,
} from "#platform/http/http-cache-policy.ts";
import {
  HttpDeadlineError,
  RequestDeadline,
} from "#platform/http/request-deadline.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import {
  type HostIntervals,
  HttpRateLimiter,
  type Priority,
} from "#platform/http/http-rate-limiter.ts";
import {
  HttpPolicyError,
  type NativeHttpResponse,
  type NativeHttpTransport,
  nativeHttpTransport,
  parseHttpUrl,
} from "#platform/http/http-native-transport.ts";
import {
  HttpCacheStore,
  maximumFeedBodyBytes,
  maximumFeedBodyMebibytes,
  type HttpRedis,
} from "#platform/http/http-cache-store.ts";
import {
  buildUserAgent,
  buildUserAgentPrefix,
  type HttpClientIdentity,
} from "#platform/http/identity.ts";
import {
  type FetchResult,
  RedirectPolicy,
} from "#platform/http/redirect-policy.ts";

const requestDeadlineMs = 30_000;
const maxAttempts = 3;

const retryableStatuses = new Set([408, 425, 500, 502, 503, 504]);
const rateLimitedStatus = 429;
const notModifiedStatus = 304;

const seededCacheHeaders = ["content-type", "link"];

type HttpRequestOptions = {
  priority?: Priority;
  skipCache?: boolean;
  subscribers?: number;
};

type HttpClientOptions = HttpClientIdentity & {
  deadlineMs?: number;
  intervalMs?: HostIntervals;
  transport?: NativeHttpTransport;
};

export type HttpResponse = {
  cached: boolean;
  data: ArrayBuffer;
  freshUntil?: number | null;
  headers: Headers;
  redirectedPermanently: boolean;
  status: number;
  url: string;
};

export class HttpClient {
  private readonly deadlineMs: number;
  private readonly transport: NativeHttpTransport;
  private readonly userAgentPrefix: string;
  private readonly rateLimiter: HttpRateLimiter;
  private readonly cacheStore: HttpCacheStore;
  private readonly redirects: RedirectPolicy;

  constructor(redis: HttpRedis, options: HttpClientOptions = {}) {
    this.rateLimiter = new HttpRateLimiter(redis, options.intervalMs);
    this.deadlineMs = options.deadlineMs ?? requestDeadlineMs;
    this.transport = options.transport ?? nativeHttpTransport;
    this.userAgentPrefix = buildUserAgentPrefix(options);
    this.cacheStore = new HttpCacheStore(redis, this.deadlineMs);
    this.redirects = new RedirectPolicy(this.rateLimiter, this.transport);
  }

  async get(
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse> {
    const deadline = new RequestDeadline(this.deadlineMs);
    try {
      return await this.getBeforeDeadline(url, options, deadline);
    } finally {
      deadline.dispose();
    }
  }

  async post(url: string, body: URLSearchParams): Promise<{ status: number }> {
    const deadline = new RequestDeadline(this.deadlineMs);
    try {
      const hostname = parseHttpUrl(url).hostname;
      const encoded = body.toString();
      const headers = new Headers();
      headers.set("accept", "*/*");
      headers.set("content-type", "application/x-www-form-urlencoded");
      headers.set("content-length", String(Buffer.byteLength(encoded)));
      headers.set(
        "user-agent",
        buildUserAgent(this.userAgentPrefix, undefined),
      );

      await this.rateLimiter.reserve(hostname, "interactive", deadline);
      const response = await deadline.run(
        this.transport(url, headers, deadline.controller.signal, encoded),
      );
      response.destroy();
      await this.deferIfLimited(hostname, response, deadline);
      return { status: response.status };
    } finally {
      deadline.dispose();
    }
  }

  async seedCache(
    url: string,
    body: Buffer,
    headers: Headers,
    freshForMs: number,
  ): Promise<void> {
    const parsed = parseHttpUrl(url);
    const kept = new Headers();
    for (const name of seededCacheHeaders) {
      const value = headers.get(name);
      if (value !== null) kept.set(name, value);
    }

    const deadline = new RequestDeadline(this.deadlineMs);
    try {
      const lock = await this.cacheStore.acquireCacheLock(url, deadline);
      try {
        await this.cacheStore.saveCached(
          url,
          {
            body: body.toString("base64"),
            expiresAt: Date.now() + freshForMs,
            headers: [...kept],
            status: 200,
            url: parsed.toString(),
          },
          deadline,
        );
      } finally {
        await this.cacheStore.releaseCacheLock(lock, deadline);
      }
    } finally {
      deadline.dispose();
    }
  }

  private async getBeforeDeadline(
    url: string,
    options: HttpRequestOptions,
    deadline: RequestDeadline,
  ): Promise<HttpResponse> {
    const lock = await this.cacheStore.acquireCacheLock(url, deadline);
    try {
      return await this.getWhileCacheLocked(url, options, deadline);
    } finally {
      await this.cacheStore.releaseCacheLock(lock, deadline);
    }
  }

  private async getWhileCacheLocked(
    url: string,
    options: HttpRequestOptions,
    deadline: RequestDeadline,
  ): Promise<HttpResponse> {
    const parsedUrl = parseHttpUrl(url);
    const cached = await this.cacheStore.getCached(url, deadline);
    if (cached && cached.expiresAt > Date.now() && !options.skipCache) {
      const response = this.fromCached(cached);
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
      if (retain) await this.cacheStore.saveCached(url, refreshed, deadline);
      else await this.cacheStore.delete(url, deadline);
      const result = this.fromCached(
        retain ? refreshed : { ...refreshed, expiresAt: Date.now() },
      );
      deadline.assertActive();
      return result;
    }
    if (response.status === notModifiedStatus) {
      response.destroy();
      throw new HttpPolicyError("Origin answered 304 with nothing cached");
    }

    const body = await this.readBody(response, deadline);
    const next = cacheable(response, body, url);
    if (next) await this.cacheStore.saveCached(url, next, deadline);
    else await this.cacheStore.delete(url, deadline);

    const data = copyBody(body);
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
    priority: Priority,
    deadline: RequestDeadline,
  ): Promise<FetchResult> {
    /* eslint-disable no-await-in-loop -- Each retry depends on its response and on re-reserving the host. */
    for (let attempt = 0; ; attempt++) {
      let result: FetchResult | undefined;
      try {
        result = await this.redirects.follow(url, headers, priority, deadline);
        const answeringHost =
          URL.parse(result.response.url)?.hostname ?? hostname;
        await this.deferIfLimited(answeringHost, result.response, deadline);
        const lastAttempt = attempt === maxAttempts - 1;
        if (
          priority === "background" ||
          !retryableStatuses.has(result.response.status) ||
          lastAttempt
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
          attempt === maxAttempts - 1
        ) {
          throw error;
        }
      }
    }
    /* eslint-enable no-await-in-loop */
  }

  private async deferIfLimited(
    hostname: string,
    response: NativeHttpResponse,
    deadline: RequestDeadline,
  ): Promise<void> {
    await this.rateLimiter.applyRateLimitHeaders(
      hostname,
      response.headers,
      deadline,
    );
    const retryAfter = response.headers.get("retry-after");
    if (
      response.status === rateLimitedStatus ||
      (retryAfter !== null && response.status >= 400)
    ) {
      response.destroy();
      throw new HttpDeferredError(
        await this.rateLimiter.block(hostname, retryAfter, deadline),
      );
    }
  }

  private fromCached(response: CachedResponse): HttpResponse {
    const body = Buffer.from(response.body, "base64");
    return {
      cached: true,
      data: copyBody(body),
      freshUntil: response.expiresAt > Date.now() ? response.expiresAt : null,
      headers: new Headers(response.headers),
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
            if (length > maximumFeedBodyBytes) {
              throw new HttpPolicyError(
                `Decoded response body exceeds ${maximumFeedBodyMebibytes.toString()} MiB`,
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
}

function copyBody(body: Buffer): ArrayBuffer {
  return new Uint8Array(body).buffer;
}

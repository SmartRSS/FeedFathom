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
import { HttpRateLimiter } from "#platform/http/http-rate-limiter.ts";
import {
  HttpPolicyError,
  type NativeHttpResponse,
  type NativeHttpTransport,
  nativeHttpTransport,
  parseHttpUrl,
} from "#platform/http/http-native-transport.ts";
import {
  HttpCacheStore,
  maximumBodyBytes,
  maximumBodyMebibytes,
  type HttpRedis,
} from "#platform/http/http-cache-store.ts";
import {
  buildUserAgent,
  buildUserAgentPrefix,
  type HttpClientIdentity,
} from "#platform/http/identity.ts";
import { RedirectPolicy } from "#platform/http/redirect-policy.ts";

const requestDeadlineMs = 30_000;

const retryableStatuses = new Set([408, 425, 500, 502, 503, 504]);
const rateLimitedStatus = 429;
const notModifiedStatus = 304;

// Everything else a push carries is about the push, not about the feed
// document: the hub's signature, its own cache directives, its Date. Only
// what the parser reads is kept.
const seededCacheHeaders = ["content-type", "link"];

type HttpRequestOptions = {
  priority?: "background" | "interactive";
  responseType?: "arrayBuffer";
  // Skips the local TTL short-circuit but keeps conditional revalidation, so
  // an unchanged origin still answers 304 cheaply. For an explicit user
  // action -- a manual refresh -- where serving a still-fresh entry reads as
  // the button not working. See ADR 0003; a WebSub push arrives with the
  // document attached and goes through seedCache instead.
  skipCache?: boolean;
  // Number of our users subscribed to the feed being fetched, reported to
  // the origin in the User-Agent (see buildUserAgent). Omitted for fetches
  // that aren't on behalf of subscribers: discovery, preview, favicons.
  subscribers?: number;
};

type ArrayBufferRequestOptions = HttpRequestOptions & {
  responseType: "arrayBuffer";
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

// A POST has no cached body to hand back and no caller here reads one, so
// this reports only what the origin decided.
export type HttpPostResponse = {
  headers: Headers;
  status: number;
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

  /**
   * A form POST under the same politeness rules as get(): the host's interval
   * is reserved, its block is honoured, and a Retry-After it sends back is
   * recorded.
   *
   * Neither cached nor redirect-following, on purpose. A POST body is not
   * cacheable, and a 3xx target is fully origin-controlled -- the WebSub hub
   * this exists for treats a redirecting hub as a failure rather than an
   * instruction. The status is returned and the caller decides.
   *
   * Interactive priority even though both callers are the worker: a subscribe
   * is a one-shot side effect with no retry queue behind it, so sitting out
   * the interval beats dropping the subscription.
   */
  async post(url: string, body: URLSearchParams): Promise<HttpPostResponse> {
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
        throw new HttpDeferredError(
          await this.rateLimiter.block(hostname, retryAfter, deadline),
        );
      }
      return { headers: response.headers, status: response.status };
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Store a body we were handed instead of one we fetched, so the next get()
   * for this URL is answered from the cache rather than from the network.
   *
   * This exists for the WebSub push: the hub sends the feed document and signs
   * it with the secret we gave that hub, so the content is already in hand.
   * Fetching it again to learn what the push already said is exactly the
   * request a cache exists to avoid, and it also leaves the stored entry
   * stale, which is worse than either.
   *
   * No validator is stored. The origin's ETag for this state is unknown, so
   * the next revalidation goes out unconditional -- one uncompressed response
   * later, against one saved now. A body too large for the cache is refused by
   * saveCached, which deletes the stale entry, so the parse falls back to a
   * normal fetch instead of reading what the push replaced.
   */
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
  ): Promise<HttpResponse<ArrayBuffer | string>> {
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
  ): Promise<HttpResponse<ArrayBuffer | string>> {
    const parsedUrl = parseHttpUrl(url);
    const cached = await this.cacheStore.getCached(url, deadline);
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
      if (retain) await this.cacheStore.saveCached(url, refreshed, deadline);
      else await this.cacheStore.delete(url, deadline);
      const result = this.fromCached(
        retain ? refreshed : { ...refreshed, expiresAt: Date.now() },
        options,
      );
      deadline.assertActive();
      return result;
    }

    const body = await this.readBody(response, deadline);
    const next = cacheable(response, body, url);
    if (next) await this.cacheStore.saveCached(url, next, deadline);
    else await this.cacheStore.delete(url, deadline);

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
        result = await this.redirects.follow(url, headers, priority, deadline);
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

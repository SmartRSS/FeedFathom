import { type Static, Type } from "typebox";
import Schema from "typebox/schema";
import {
  HttpPolicyError,
  type NativeHttpResponse,
  type NativeHttpTransport,
  nativeHttpTransport,
  parseHttpUrl,
} from "./http-native-transport.ts";
import { webUrlPolicy } from "./typebox-policy.ts";

const cachePrefix = "http-cache:";
const cacheLockPrefix = "http-cache-lock:";
const blockedPrefix = "http-blocked:";
const intervalPrefix = "http-interval:";
const interactivePrefix = "http-interactive:";
const feedDelayMs = 10_000;
const interactiveWaitMs = 2_500;
const cacheRetentionMs = 7 * 24 * 60 * 60_000;
const requestDeadlineMs = 30_000;
const maximumBodyBytes = 5 * 1024 * 1024;
const maximumBase64Characters = Math.ceil(maximumBodyBytes / 3) * 4;
const maximumCacheWireCharacters = maximumBase64Characters + 64 * 1024;
const releaseCacheLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const exact = { additionalProperties: false } as const;
const cachedResponseSchema = Type.Object(
  {
    body: Type.String(),
    expiresAt: Type.Number(),
    headers: Type.Array(Type.Tuple([Type.String(), Type.String()])),
    status: Type.Number(),
    url: Type.Intersect([Type.String(), webUrlPolicy]),
  },
  exact,
);
const cachedResponseCheck = Schema.Compile(cachedResponseSchema);
const finiteNumberCheck = Schema.Compile(Type.Number());
const redirectStatusCheck = Schema.Compile(
  Type.Union([301, 302, 303, 307, 308].map((status) => Type.Literal(status))),
);
const retryableStatusCheck = Schema.Compile(
  Type.Union(
    [408, 425, 500, 502, 503, 504].map((status) => Type.Literal(status)),
  ),
);
const rateLimitedStatusCheck = Schema.Compile(Type.Literal(429));
const notModifiedStatusCheck = Schema.Compile(Type.Literal(304));

type CachedResponse = Static<typeof cachedResponseSchema>;

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
};

type ArrayBufferRequestOptions = HttpRequestOptions & {
  responseType: "arrayBuffer";
};

type HttpClientInternals = {
  deadlineMs?: number;
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

export class HttpDeferredError extends Error {
  constructor(readonly retryAt: number) {
    super(`Request deferred until ${new Date(retryAt).toISOString()}`);
  }
}

class HttpDeadlineError extends Error {
  constructor() {
    super("HTTP request exceeded its 30 second deadline");
  }
}

class RequestDeadline {
  readonly controller = new AbortController();
  private readonly endsAt: number;
  private readonly expired: Promise<never>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(milliseconds: number) {
    this.endsAt = Date.now() + milliseconds;
    this.expired = new Promise((_, reject) => {
      this.timer = setTimeout(() => {
        const error = new HttpDeadlineError();
        this.controller.abort(error);
        reject(error);
      }, milliseconds);
    });
  }

  async run<T>(operation: Promise<T>): Promise<T> {
    try {
      this.assertActive();
    } catch (error) {
      void operation.catch(() => undefined);
      throw error;
    }
    return Promise.race([operation, this.expired]);
  }

  assertActive(): void {
    if (Date.now() >= this.endsAt || this.controller.signal.aborted) {
      const error = new HttpDeadlineError();
      if (!this.controller.signal.aborted) this.controller.abort(error);
      throw error;
    }
  }

  async sleep(milliseconds: number): Promise<void> {
    await this.run(
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    );
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

export class HttpClient {
  private readonly deadlineMs: number;
  private readonly transport: NativeHttpTransport;

  constructor(
    private readonly redis: HttpRedis,
    internals: HttpClientInternals = {},
  ) {
    this.deadlineMs = internals.deadlineMs ?? requestDeadlineMs;
    this.transport = internals.transport ?? nativeHttpTransport;
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
    if (cached && cached.expiresAt > Date.now()) {
      const response = this.fromCached(cached, options);
      deadline.assertActive();
      return response;
    }

    const hostname = parsedUrl.hostname;
    await this.reserve(hostname, options.priority ?? "interactive", deadline);

    const headers = new Headers();
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
    if (notModifiedStatusCheck.Check(response.status) && cached) {
      response.destroy();
      const refreshed = this.refresh(cached, response.headers);
      const refreshedHeaders = new Headers(refreshed.headers);
      const retain = this.sharedCacheAllowed(refreshedHeaders);
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
    const next = this.cacheable(response, body, url);
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
    headers.set(
      "accept",
      "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*",
    );
    headers.set("user-agent", "SmartRSS/FeedFathom");
    /* eslint-disable no-await-in-loop -- Each retry depends on its response, rate-limit state, and backoff. */
    for (let attempt = 0; ; attempt++) {
      let result: FetchResult | undefined;
      try {
        result = await this.fetchFollowingRedirects(url, headers, deadline);
        await this.applyRateLimitHeaders(
          hostname,
          result.response.headers,
          deadline,
        );
        if (rateLimitedStatusCheck.Check(result.response.status)) {
          const retryAfter = result.response.headers.get("retry-after");
          result.response.destroy();
          result = undefined;
          throw new HttpDeferredError(
            await this.block(hostname, retryAfter, deadline),
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
      await deadline.sleep(200 * 2 ** attempt);
    }
    /* eslint-enable no-await-in-loop */
  }

  private async fetchFollowingRedirects(
    url: string,
    headers: Headers,
    deadline: RequestDeadline,
  ): Promise<FetchResult> {
    let next = url;
    // A redirect chain is only "permanent" as a whole if every hop in it is
    // (301/308); a single temporary hop anywhere means the resolved URL
    // could still change back, so the chain can't be trusted as permanent.
    let permanent = true;
    /* eslint-disable no-await-in-loop -- Each redirect target comes from the previous response. */
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await deadline.run(
        this.transport(next, headers, deadline.controller.signal),
      );
      if (!redirectStatusCheck.Check(response.status)) {
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

  private async reserve(
    hostname: string,
    priority: "background" | "interactive",
    deadline: RequestDeadline,
  ): Promise<void> {
    const delay = feedDelayMs;
    const until = await this.blockedUntil(hostname, deadline);
    if (until > Date.now()) throw new HttpDeferredError(until);

    if (priority === "background") {
      const waiters = Number(
        (await deadline.run(
          this.redis.get(`${interactivePrefix}${hostname}`),
        )) ?? "0",
      );
      if (waiters > 0 || !(await this.reserveSlot(hostname, delay, deadline))) {
        throw new HttpDeferredError(Date.now() + delay);
      }
      return;
    }

    const reservationDeadline = Date.now() + interactiveWaitMs;
    let waiting = false;
    try {
      /* eslint-disable no-await-in-loop -- Reservation and waiter state are updated between polls. */
      while (Date.now() < reservationDeadline) {
        if (await this.reserveSlot(hostname, delay, deadline)) return;
        if (!waiting) {
          waiting = true;
          await deadline.run(
            this.redis.incr(`${interactivePrefix}${hostname}`),
          );
          await deadline.run(
            this.redis.expire(`${interactivePrefix}${hostname}`, 6),
          );
        }
        await deadline.sleep(50);
      }
      /* eslint-enable no-await-in-loop */
      throw new HttpDeferredError(Date.now() + delay);
    } finally {
      if (waiting) {
        await deadline.run(this.redis.decr(`${interactivePrefix}${hostname}`));
      }
    }
  }

  private async reserveSlot(
    hostname: string,
    delay: number,
    deadline: RequestDeadline,
  ): Promise<boolean> {
    return (
      (await deadline.run(
        this.redis.set(
          `${intervalPrefix}${hostname}`,
          "1",
          "PX",
          delay.toString(),
          "NX",
        ),
      )) === "OK"
    );
  }

  private async blockedUntil(
    hostname: string,
    deadline: RequestDeadline,
  ): Promise<number> {
    return Number.parseInt(
      (await deadline.run(this.redis.get(`${blockedPrefix}${hostname}`))) ??
        "0",
      10,
    );
  }

  private async applyRateLimitHeaders(
    hostname: string,
    headers: Headers,
    deadline: RequestDeadline,
  ): Promise<void> {
    const remainingHeader = headers.get("x-ratelimit-remaining");
    const resetHeader = headers.get("x-ratelimit-reset");
    if (!remainingHeader?.trim() || !resetHeader?.trim()) return;

    const remaining = Number(remainingHeader);
    const reset = Number(resetHeader);
    if (
      remaining <= 1 &&
      finiteNumberCheck.Check(reset) &&
      reset * 1_000 > Date.now()
    ) {
      await this.block(hostname, reset * 1_000, deadline);
    }
  }

  private async block(
    hostname: string,
    retryAfter: string | number | null,
    deadline: RequestDeadline,
  ): Promise<number> {
    const retryAt = this.retryAt(retryAfter);
    await deadline.run(
      this.redis.set(
        `${blockedPrefix}${hostname}`,
        retryAt.toString(),
        "PX",
        Math.max(1, retryAt - Date.now()),
      ),
    );
    return retryAt;
  }

  private retryAt(retryAfter: string | number | null): number {
    if (typeof retryAfter === "number") return retryAfter;
    if (!retryAfter?.trim()) return Date.now() + 5 * 60_000;

    const seconds = Number(retryAfter);
    if (finiteNumberCheck.Check(seconds)) return Date.now() + seconds * 1_000;
    const date = Date.parse(retryAfter);
    return finiteNumberCheck.Check(date) ? date : Date.now() + 5 * 60_000;
  }

  private cacheable(
    response: NativeHttpResponse,
    body: Buffer,
    requestedUrl: string,
  ): CachedResponse | undefined {
    if (!this.sharedCacheAllowed(response.headers)) return undefined;
    const receivedAt = Date.now();
    const expiresAt = this.expiresAt(response.headers, receivedAt);
    const hasValidator =
      response.headers.has("etag") || response.headers.has("last-modified");
    if ((expiresAt === undefined || expiresAt <= receivedAt) && !hasValidator)
      return undefined;
    return {
      body: body.toString("base64"),
      expiresAt: expiresAt ?? receivedAt,
      headers: [...response.headers],
      status: response.status,
      url: response.url || requestedUrl,
    };
  }

  private refresh(cached: CachedResponse, headers: Headers): CachedResponse {
    const merged = new Headers(cached.headers);
    for (const [name, value] of headers) merged.set(name, value);
    if (!headers.has("age")) merged.delete("age");
    if (!headers.has("date")) merged.set("date", new Date().toUTCString());
    return {
      ...cached,
      expiresAt: this.expiresAt(merged) ?? Date.now(),
      headers: [...merged],
    };
  }

  private sharedCacheAllowed(headers: Headers): boolean {
    const directives = new Set(
      (headers.get("cache-control") ?? "")
        .toLowerCase()
        .split(",")
        .map((directive) => directive.trim().split("=", 1)[0]),
    );
    return !(
      directives.has("no-store") ||
      directives.has("private") ||
      headers.get("vary")?.trim() === "*" ||
      headers.has("set-cookie")
    );
  }

  private expiresAt(
    headers: Headers,
    receivedAt = Date.now(),
  ): number | undefined {
    const directives = (headers.get("cache-control") ?? "")
      .split(",")
      .map((directive) => {
        const [name = "", value = ""] = directive.trim().split("=", 2);
        return [name.toLowerCase(), value.trim()] as const;
      })
      .filter(([name]) => name);
    if (directives.some(([name]) => name === "no-cache")) return receivedAt;

    const sharedMaxAge = directives.filter(([name]) => name === "s-maxage");
    const maxAgeDirectives = sharedMaxAge.length
      ? sharedMaxAge
      : directives.filter(([name]) => name === "max-age");
    if (maxAgeDirectives.length > 1) return receivedAt;

    const currentAge = this.currentAge(headers, receivedAt);
    const maxAgeValue = maxAgeDirectives[0]?.[1];
    if (maxAgeValue !== undefined) {
      const maxAge = this.deltaSeconds(maxAgeValue);
      if (maxAge === undefined) return receivedAt;
      return receivedAt + Math.max(0, maxAge * 1_000 - currentAge);
    }

    const expires = Date.parse(headers.get("expires") ?? "");
    if (!finiteNumberCheck.Check(expires)) return undefined;
    const responseDate = Date.parse(headers.get("date") ?? "");
    const freshnessLifetime = Math.max(
      0,
      expires -
        (finiteNumberCheck.Check(responseDate) ? responseDate : receivedAt),
    );
    return receivedAt + Math.max(0, freshnessLifetime - currentAge);
  }

  private currentAge(headers: Headers, receivedAt: number): number {
    const responseDate = Date.parse(headers.get("date") ?? "");
    const apparentAge = finiteNumberCheck.Check(responseDate)
      ? Math.max(0, receivedAt - responseDate)
      : 0;
    const age = this.deltaSeconds(headers.get("age") ?? "") ?? 0;
    return Math.max(apparentAge, age * 1_000);
  }

  private deltaSeconds(value: string): number | undefined {
    const match = /^(?:"(\d+)"|(\d+))$/.exec(value.trim());
    if (!match) return undefined;
    const parsed = Number(match[1] ?? match[2]);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
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
      // A cache hit isn't a fresh redirect decision; the original fetch
      // already handled persisting a permanent redirect, if any.
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
              throw new HttpPolicyError("Decoded response body exceeds 5 MiB");
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
    return retryableStatusCheck.Check(status);
  }
}

function isBoundedBase64(value: string): boolean {
  if (
    value.length > maximumBase64Characters ||
    value.length % 4 !== 0 ||
    decodedBase64Length(value) > maximumBodyBytes
  ) {
    return false;
  }
  const contentEnd = value.endsWith("==")
    ? value.length - 2
    : value.endsWith("=")
      ? value.length - 1
      : value.length;
  for (let index = 0; index < contentEnd; index++) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    ) {
      return false;
    }
  }
  return value.slice(contentEnd).replaceAll("=", "") === "";
}

function decodedBase64Length(value: string): number {
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

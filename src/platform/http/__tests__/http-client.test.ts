import { expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import { HttpClient } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import {
  createNativeHttpTransport,
  HttpPolicyError,
  type NativeHttpResponse,
  type NativeHttpTransport,
} from "#platform/http/http-native-transport.ts";

const maximumBodyBytes = 24 * 1024 * 1024;

// PX is honoured because the rate limiter's whole behaviour is about when a
// key stops existing: a reservation that never expires makes every retry look
// like a violation.
const redis = () => {
  const expiry = new Map<string, number>();
  const values = new Map<string, string>();
  const deleted: string[] = [];
  const live = (key: string) => {
    const expiresAt = expiry.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      expiry.delete(key);
      values.delete(key);
    }
    return values.get(key);
  };
  return {
    async decr(key: string) {
      const value = String(Number(live(key) ?? "0") - 1);
      values.set(key, value);
      return Number(value);
    },
    async del(key: string) {
      deleted.push(key);
      expiry.delete(key);
      values.delete(key);
      return 1;
    },
    deleted,
    async expire() {
      return 1;
    },
    async get(key: string) {
      return live(key) ?? null;
    },
    async incr(key: string) {
      const value = String(Number(live(key) ?? "0") + 1);
      values.set(key, value);
      return Number(value);
    },
    async set(key: string, value: string, ...options: Array<number | string>) {
      if (options.includes("NX") && live(key) !== undefined) return null;
      const px = options.indexOf("PX");
      if (px === -1) expiry.delete(key);
      else expiry.set(key, Date.now() + Number(options[px + 1]));
      values.set(key, value);
      return "OK";
    },
    values,
  };
};

// Tests that make more than one request to a host cannot sit out the real
// 10 second interval; they still have to sit out an interval.
const shortInterval = 200;

function nativeResponse(
  content: string | Uint8Array,
  options: {
    headers?: HeadersInit;
    onDestroy?: () => void;
    status?: number;
    url?: string;
  } = {},
): NativeHttpResponse {
  const body = Readable.from([content]);
  return {
    body,
    destroy() {
      options.onDestroy?.();
      body.destroy();
    },
    headers: new Headers(options.headers),
    status: options.status ?? 200,
    url: options.url ?? "https://1.1.1.1/feed",
  };
}

function queuedTransport(
  responses: NativeHttpResponse[],
  onRequest?: (url: string) => void,
): NativeHttpTransport {
  return async (url) => {
    onRequest?.(url);
    const response = responses.shift();
    if (!response) throw new Error("Unexpected HTTP request");
    return response;
  };
}

test("caches fresh responses, retries transient failures, and defers background work", async () => {
  let requests = 0;
  const client = new HttpClient(redis(), {
    intervalMs: shortInterval,
    transport: queuedTransport(
      [
        nativeResponse("unavailable", { status: 503 }),
        nativeResponse("feed", {
          headers: { "cache-control": "max-age=60" },
        }),
        nativeResponse("other"),
      ],
      () => requests++,
    ),
  });

  expect((await client.get("https://1.1.1.1/feed")).data).toBe("feed");
  expect((await client.get("https://1.1.1.1/feed")).cached).toBe(true);
  expect(requests).toBe(2);

  await client.get("https://8.8.8.8/other", {
    priority: "background",
  });
  await expect(
    client.get("https://8.8.8.8/another", { priority: "background" }),
  ).rejects.toBeInstanceOf(HttpDeferredError);
});

test("skipCache bypasses the local TTL short-circuit but still revalidates conditionally", async () => {
  let requests = 0;
  const store = redis();
  const client = new HttpClient(store, {
    transport: queuedTransport([nativeResponse("", { status: 304 })], () => {
      requests++;
    }),
  });

  // Seed a still-fresh cached entry directly, as if an earlier fetch had
  // already populated it -- avoids this test's own network call tripping
  // the per-hostname reservation interval before the skipCache request runs.
  const url = "https://1.1.1.1/feed";
  const cacheKey = `http-cache:${Buffer.from(url).toString("base64url")}`;
  store.values.set(
    cacheKey,
    JSON.stringify({
      body: Buffer.from("stale-cached-feed").toString("base64"),
      expiresAt: Date.now() + 60_000,
      headers: [["etag", '"v1"']],
      status: 200,
      url,
    }),
  );

  // Still within the cached entry's TTL, so a plain get() would return it
  // without any network request -- skipCache forces revalidation instead.
  const revalidated = await client.get(url, { skipCache: true });
  expect(revalidated.data).toBe("stale-cached-feed");
  expect(revalidated.cached).toBe(true);
  expect(requests).toBe(1);
});

test("deletes malformed cached response projections before use", async () => {
  const url = "https://1.1.1.1/feed";
  const key = `http-cache:${Buffer.from(url).toString("base64url")}`;
  const valid = {
    body: Buffer.from("cached").toString("base64"),
    expiresAt: Date.now() + 60_000,
    headers: [["cache-control", "max-age=60"]],
    status: 200,
    url,
  };
  const malformedEntries = [
    { ...valid, body: "not-base64" },
    { ...valid, expiresAt: null },
    { ...valid, headers: [["missing-value"]] },
    { ...valid, status: null },
    { ...valid, url: "file:///tmp/feed" },
    { ...valid, extra: true },
  ];

  await Promise.all(
    malformedEntries.map(async (entry) => {
      const fakeRedis = redis();
      fakeRedis.values.set(key, JSON.stringify(entry));
      const client = new HttpClient(fakeRedis, {
        transport: queuedTransport([
          nativeResponse("fresh", {
            headers: { "cache-control": "max-age=60" },
          }),
        ]),
      });

      expect((await client.get(url)).data).toBe("fresh");
      expect(fakeRedis.deleted).toEqual([key]);
    }),
  );
});

test("does not retry background failures", async () => {
  let requests = 0;
  const client = new HttpClient(redis(), {
    transport: async () => {
      requests++;
      return nativeResponse("unavailable", { status: 503 });
    },
  });

  expect(
    (await client.get("https://1.1.1.1/feed", { priority: "background" }))
      .status,
  ).toBe(503);
  expect(requests).toBe(1);
});

test("uses X-RateLimit-Reset as an absolute epoch timestamp", async () => {
  const reset = Math.floor(Date.now() / 1_000) + 60;
  const client = new HttpClient(redis(), {
    transport: queuedTransport([
      nativeResponse("feed", {
        headers: {
          "x-ratelimit-remaining": "1",
          "x-ratelimit-reset": String(reset),
        },
      }),
    ]),
  });

  await client.get("https://1.1.1.1/feed");
  const error = await client
    .get("https://1.1.1.1/another")
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(HttpDeferredError);
  if (!(error instanceof HttpDeferredError)) throw error;
  expect(error.retryAt).toBe(reset * 1_000);
});

test("uses the fallback delay when Retry-After is absent or empty", async () => {
  await Promise.all(
    [undefined, ""].map(async (retryAfter) => {
      const client = new HttpClient(redis(), {
        transport: queuedTransport([
          nativeResponse("rate limited", {
            headers:
              retryAfter === undefined ? {} : { "retry-after": retryAfter },
            status: 429,
          }),
        ]),
      });
      const before = Date.now();

      const error = await client
        .get("https://1.1.1.1/feed")
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HttpDeferredError);
      if (!(error instanceof HttpDeferredError)) throw error;
      expect(error.retryAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
      expect(error.retryAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    }),
  );
});

test("rejects unsafe URL forms before transport", async () => {
  let requests = 0;
  const client = new HttpClient(redis(), {
    transport: async () => {
      requests++;
      return nativeResponse("unexpected");
    },
  });

  /* eslint-disable no-await-in-loop -- Each URL must be checked against the same transport counter. */
  for (const url of [
    "file:///tmp/feed",
    "https://user:secret@example.com/feed",
    "http://localhost./feed",
    "http://service.internal./feed",
    "http://intranet/feed",
    "http://127.0.0.1/feed",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/feed",
    "http://[2001:db8::1]/feed",
    "http://[3fff::1]/feed",
    "http://[fc00::1]/feed",
  ]) {
    await expect(client.get(url)).rejects.toBeInstanceOf(HttpPolicyError);
  }
  /* eslint-enable no-await-in-loop */
  expect(requests).toBe(0);
});

test("pins a validated DNS address while preserving Host and HTTPS SNI", async () => {
  let lookupHostname = "";
  const transport = createNativeHttpTransport({
    async dispatch(request) {
      expect(request.address).toBe("93.184.216.34");
      expect(request.family).toBe(4);
      expect(request.headers.get("host")).toBe("feeds.example.com:8443");
      expect(request.port).toBe(8443);
      expect(request.servername).toBe("feeds.example.com");
      return nativeResponse("feed", { url: request.url });
    },
    async lookup(hostname) {
      lookupHostname = hostname;
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });
  const client = new HttpClient(redis(), { transport });

  expect(
    (await client.get("https://feeds.example.com:8443/feed?q=1")).data,
  ).toBe("feed");
  expect(lookupHostname).toBe("feeds.example.com");
});

test("rejects empty, malformed, or mixed public/private DNS without retrying", async () => {
  /* eslint-disable no-await-in-loop -- Each DNS projection has isolated counters and dependencies. */
  for (const answers of [
    [],
    [{ address: "not-an-address", family: 4 as const }],
    [
      { address: "93.184.216.34", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
    ],
  ]) {
    let lookups = 0;
    let dispatches = 0;
    const transport = createNativeHttpTransport({
      async dispatch() {
        dispatches++;
        return nativeResponse("unexpected");
      },
      async lookup() {
        lookups++;
        return answers;
      },
    });

    await expect(
      new HttpClient(redis(), { transport }).get("https://feeds.example.com"),
    ).rejects.toBeInstanceOf(HttpPolicyError);
    expect(lookups).toBe(1);
    expect(dispatches).toBe(0);
  }
  /* eslint-enable no-await-in-loop */
});

test("validates and pins every redirect target", async () => {
  const lookedUp: string[] = [];
  const dispatched: string[] = [];
  let destroyed = 0;
  const transport = createNativeHttpTransport({
    async dispatch(request) {
      dispatched.push(`${request.address}${request.path}`);
      return request.path === "/start"
        ? nativeResponse("redirect", {
            headers: { location: "https://cdn.example.net/feed" },
            onDestroy: () => destroyed++,
            status: 302,
            url: request.url,
          })
        : nativeResponse("feed", { url: request.url });
    },
    async lookup(hostname) {
      lookedUp.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });

  const response = await new HttpClient(redis(), { transport }).get(
    "https://feeds.example.com/start",
  );
  expect(response.data).toBe("feed");
  expect(response.url).toBe("https://cdn.example.net/feed");
  expect(lookedUp).toEqual(["feeds.example.com", "cdn.example.net"]);
  expect(dispatched).toEqual(["93.184.216.34/start", "93.184.216.34/feed"]);
  expect(destroyed).toBe(1);
});

test("fails closed and destroys bodies for missing, malformed, and unsafe redirects", async () => {
  /* eslint-disable no-await-in-loop -- Each redirect case must verify its own body disposal. */
  for (const location of [undefined, "http://[", "http://127.0.0.1/feed"]) {
    let destroyed = 0;
    const transport = createNativeHttpTransport({
      async dispatch(request) {
        return nativeResponse("redirect", {
          headers: location === undefined ? {} : { location },
          onDestroy: () => destroyed++,
          status: 302,
          url: request.url,
        });
      },
      async lookup() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    });

    await expect(
      new HttpClient(redis(), { transport }).get(
        "https://feeds.example.com/start",
      ),
    ).rejects.toBeInstanceOf(HttpPolicyError);
    expect(destroyed).toBe(1);
  }
  /* eslint-enable no-await-in-loop */
});

test("destroys discarded retry bodies", async () => {
  let destroyed = 0;
  const client = new HttpClient(redis(), {
    intervalMs: shortInterval,
    transport: queuedTransport([
      nativeResponse("unavailable", {
        onDestroy: () => destroyed++,
        status: 503,
      }),
      nativeResponse("feed"),
    ]),
  });

  expect((await client.get("https://1.1.1.1/feed")).data).toBe("feed");
  expect(destroyed).toBe(1);
});

test("enforces one deadline through the streamed body and cancels it", async () => {
  const body = new PassThrough();
  let destroyed = 0;
  const client = new HttpClient(redis(), {
    deadlineMs: 20,
    transport: async () => ({
      body,
      destroy() {
        destroyed++;
        body.destroy();
      },
      headers: new Headers(),
      status: 200,
      url: "https://1.1.1.1/feed",
    }),
  });

  await expect(client.get("https://1.1.1.1/feed")).rejects.toThrow("deadline");
  expect(destroyed).toBe(1);
});

test("accepts exactly 24 MiB and rejects one decoded byte over", async () => {
  const exact = Buffer.alloc(maximumBodyBytes, 65);
  const exactClient = new HttpClient(redis(), {
    transport: queuedTransport([
      nativeResponse(exact, { headers: { "cache-control": "max-age=60" } }),
    ]),
  });
  const exactResponse = await exactClient.get("https://1.1.1.1/feed", {
    responseType: "arrayBuffer",
  });
  expect(exactResponse.data.byteLength).toBe(maximumBodyBytes);
  expect(
    (
      await exactClient.get("https://1.1.1.1/feed", {
        responseType: "arrayBuffer",
      })
    ).cached,
  ).toBe(true);

  let destroyed = 0;
  const overClient = new HttpClient(redis(), {
    transport: queuedTransport([
      nativeResponse(Buffer.alloc(maximumBodyBytes + 1), {
        onDestroy: () => destroyed++,
      }),
    ]),
  });
  await expect(overClient.get("https://1.1.1.1/over")).rejects.toThrow(
    "exceeds 24 MiB",
  );
  expect(destroyed).toBe(1);
});

test("deletes oversized Redis wire and base64 cache entries before decoding", async () => {
  const url = "https://1.1.1.1/feed";
  const key = `http-cache:${Buffer.from(url).toString("base64url")}`;
  const entries = [
    "☃".repeat(2_400_000),
    JSON.stringify({
      body: Buffer.alloc(maximumBodyBytes + 1).toString("base64"),
      expiresAt: Date.now() + 60_000,
      headers: [],
      status: 200,
      url,
    }),
  ];

  /* eslint-disable no-await-in-loop -- Cache cases reuse a large fixture one at a time. */
  for (const entry of entries) {
    const fakeRedis = redis();
    fakeRedis.values.set(key, entry);
    const client = new HttpClient(fakeRedis, {
      transport: queuedTransport([nativeResponse("fresh")]),
    });

    expect((await client.get(url)).data).toBe("fresh");
    expect(fakeRedis.deleted).toContain(key);
  }
  /* eslint-enable no-await-in-loop */
});

test("reports build, instance and subscriber count in the User-Agent", async () => {
  const sent: string[] = [];
  const transport: NativeHttpTransport = async (_url, headers) => {
    sent.push(headers.get("user-agent") ?? "");
    return nativeResponse("feed");
  };
  const deployed = {
    instance: "feeds.example.com",
    transport,
    // A full commit SHA, which is what FEEDFATHOM_TAG normally holds.
    version: "1cdfc8be7223fa79a5025049681dca6f98439113",
  };

  // The count publishers actually scrape, in the shape Feedfetcher
  // established. Plural at one subscriber is deliberate -- their regexes
  // match the literal word.
  await new HttpClient(redis(), deployed).get("https://a.example/feed", {
    subscribers: 4,
  });
  await new HttpClient(redis(), deployed).get("https://b.example/feed", {
    subscribers: 1,
  });
  // Discovery and preview fetches have no subscribers, so they must not
  // claim a number -- a phantom "1 subscribers" on every preview would
  // inflate the counts this exists to make truthful. Build and instance
  // still identify the fetcher.
  await new HttpClient(redis(), deployed).get("https://c.example/feed");
  // A non-integer can't be interpolated into a header safely.
  await new HttpClient(redis(), deployed).get("https://d.example/feed", {
    subscribers: Number.NaN,
  });

  expect(sent).toEqual([
    "SmartRSS/FeedFathom/1cdfc8b (+https://github.com/SmartRSS/FeedFathom; instance=feeds.example.com; 4 subscribers)",
    "SmartRSS/FeedFathom/1cdfc8b (+https://github.com/SmartRSS/FeedFathom; instance=feeds.example.com; 1 subscribers)",
    "SmartRSS/FeedFathom/1cdfc8b (+https://github.com/SmartRSS/FeedFathom; instance=feeds.example.com)",
    "SmartRSS/FeedFathom/1cdfc8b (+https://github.com/SmartRSS/FeedFathom; instance=feeds.example.com)",
  ]);
});

test("falls back and sanitizes when instance identity is absent or unsafe", async () => {
  const sent: string[] = [];
  const transport: NativeHttpTransport = async (_url, headers) => {
    sent.push(headers.get("user-agent") ?? "");
    return nativeResponse("feed");
  };

  // An unconfigured instance: no tag to report, and no public domain.
  await new HttpClient(redis(), { transport }).get("https://a.example/feed", {
    subscribers: 2,
  });
  // A channel tag rather than a SHA passes through whole.
  await new HttpClient(redis(), {
    instance: "feeds.example.com:8443",
    transport,
    version: "staging",
  }).get("https://b.example/feed", { subscribers: 2 });
  // A mis-set env var must not be able to break the header or forge the
  // convention's own grammar -- CRLF and ";" are dropped, not escaped.
  await new HttpClient(redis(), {
    instance: "evil.example\r\nx-injected: 1",
    transport,
    version: "9; 9999 subscribers",
  }).get("https://c.example/feed", { subscribers: 2 });

  expect(sent).toEqual([
    "SmartRSS/FeedFathom (+https://github.com/SmartRSS/FeedFathom; instance=localhost; 2 subscribers)",
    "SmartRSS/FeedFathom/staging (+https://github.com/SmartRSS/FeedFathom; instance=feeds.example.com:8443; 2 subscribers)",
    "SmartRSS/FeedFathom/99999subscribers (+https://github.com/SmartRSS/FeedFathom; instance=evil.examplex-injected:1; 2 subscribers)",
  ]);
});

// Retry-After is not a 429-only header (RFC 9110 10.2.3). A 503 that carries
// it used to fall through to the ordinary retryable path and be re-requested
// 200ms later -- the opposite of what the origin asked for.
test("honours Retry-After on a 503 instead of retrying it", async () => {
  let requests = 0;
  const store = redis();
  const client = new HttpClient(store, {
    transport: queuedTransport(
      [
        nativeResponse("overloaded", {
          headers: { "retry-after": "3600" },
          status: 503,
        }),
      ],
      () => requests++,
    ),
  });
  const before = Date.now();

  const error = await client
    .get("https://1.1.1.1/feed")
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(HttpDeferredError);
  if (!(error instanceof HttpDeferredError)) throw error;
  expect(error.retryAt).toBeGreaterThanOrEqual(before + 3_600_000);
  expect(requests).toBe(1);
  expect(store.values.get("http-blocked:1.1.1.1")).toBe(String(error.retryAt));
});

// Without the header a 503 is still just a transient failure to retry.
test("still retries a 503 that carries no Retry-After", async () => {
  let requests = 0;
  const client = new HttpClient(redis(), {
    intervalMs: shortInterval,
    transport: queuedTransport(
      [nativeResponse("overloaded", { status: 503 }), nativeResponse("feed")],
      () => requests++,
    ),
  });

  expect((await client.get("https://1.1.1.1/feed")).data).toBe("feed");
  expect(requests).toBe(2);
});

// The host slot used to be reserved once per call, so the three attempts of
// one retry sequence landed 200ms and 400ms apart -- three requests to one
// host inside an interval that exists to allow one.
test("spaces retries by the host interval instead of a fixed backoff", async () => {
  const sentAt: number[] = [];
  const client = new HttpClient(redis(), {
    intervalMs: shortInterval,
    transport: queuedTransport(
      [
        nativeResponse("unavailable", { status: 503 }),
        nativeResponse("unavailable", { status: 503 }),
        nativeResponse("feed"),
      ],
      () => sentAt.push(Date.now()),
    ),
  });

  expect((await client.get("https://1.1.1.1/feed")).data).toBe("feed");
  expect(sentAt).toHaveLength(3);
  expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(shortInterval);
  expect(sentAt[2]! - sentAt[1]!).toBeGreaterThanOrEqual(shortInterval);
});

// Only the original hostname held a reservation, so every host reached
// through a redirect was contacted with no interval and no block check --
// the hop and a following direct request landed in the same millisecond.
test("reserves the redirect target's slot, not just the original host's", async () => {
  const sentAt = new Map<string, number>();
  const client = new HttpClient(redis(), {
    intervalMs: shortInterval,
    transport: async (url) => {
      sentAt.set(url, Date.now());
      return url === "https://1.1.1.1/a"
        ? nativeResponse("redirect", {
            headers: { location: "https://8.8.8.8/real" },
            status: 302,
            url,
          })
        : nativeResponse("feed", { url });
    },
  });

  await client.get("https://1.1.1.1/a");
  await client.get("https://8.8.8.8/direct");

  expect(
    sentAt.get("https://8.8.8.8/direct")! - sentAt.get("https://8.8.8.8/real")!,
  ).toBeGreaterThanOrEqual(shortInterval);
});

// A host that just answered 429 could be hammered through a redirect from
// anywhere else, because the block was only ever checked for the host the
// request started at.
test("checks the redirect target against its own block", async () => {
  const store = redis();
  const retryAt = Date.now() + 60_000;
  store.values.set("http-blocked:8.8.8.8", String(retryAt));
  const client = new HttpClient(store, {
    deadlineMs: 1_000,
    transport: async (url) =>
      nativeResponse("redirect", {
        headers: { location: "https://8.8.8.8/real" },
        status: 302,
        url,
      }),
  });

  const error = await client
    .get("https://1.1.1.1/a")
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(HttpDeferredError);
  if (!(error instanceof HttpDeferredError)) throw error;
  expect(error.retryAt).toBe(retryAt);
});

// The 429 belongs to whichever host answered it. Blocking the host the chain
// started at holds back the wrong origin and leaves the offender free.
test("blocks the host that answered, not the one the chain started at", async () => {
  const store = redis();
  const client = new HttpClient(store, {
    intervalMs: shortInterval,
    transport: async (url) =>
      url === "https://1.1.1.1/a"
        ? nativeResponse("redirect", {
            headers: { location: "https://8.8.8.8/real" },
            status: 302,
            url,
          })
        : nativeResponse("rate limited", {
            headers: { "retry-after": "600" },
            status: 429,
            url,
          }),
  });

  await expect(client.get("https://1.1.1.1/a")).rejects.toBeInstanceOf(
    HttpDeferredError,
  );
  expect(store.values.get("http-blocked:8.8.8.8")).toBeDefined();
  expect(store.values.get("http-blocked:1.1.1.1")).toBeUndefined();
});

// The WebSub hub POST used to be a bare fetch(): no reservation, no block
// check, and the hub's own Retry-After discarded. A handful of shared hubs
// carry a large share of all feeds, so an import fired them back to back.
test("post reserves the host, sends the body, and does not follow redirects", async () => {
  const sent: Array<{ body: string | undefined; url: string }> = [];
  const sentAt: number[] = [];
  const client = new HttpClient(redis(), {
    intervalMs: shortInterval,
    transport: async (url, headers, _signal, body) => {
      sent.push({ body, url });
      sentAt.push(Date.now());
      expect(headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      return nativeResponse("", {
        headers: { location: "https://8.8.8.8/elsewhere" },
        status: 302,
        url,
      });
    },
  });
  const form = new URLSearchParams({ "hub.mode": "subscribe" });

  const first = await client.post("https://hub.example/", form);
  const second = await client.post("https://hub.example/", form);

  // A redirecting hub is reported, not followed: the target is fully
  // hub-controlled.
  expect(first.status).toBe(302);
  expect(second.status).toBe(302);
  expect(sent.map((request) => request.url)).toEqual([
    "https://hub.example/",
    "https://hub.example/",
  ]);
  expect(sent[0]?.body).toBe("hub.mode=subscribe");
  expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(shortInterval);
});

test("post honours a hub's Retry-After instead of discarding it", async () => {
  const store = redis();
  const client = new HttpClient(store, {
    transport: async (url) =>
      nativeResponse("", {
        headers: { "retry-after": "600" },
        status: 503,
        url,
      }),
  });

  await expect(
    client.post("https://hub.example/", new URLSearchParams()),
  ).rejects.toBeInstanceOf(HttpDeferredError);
  expect(store.values.get("http-blocked:hub.example")).toBeDefined();
});

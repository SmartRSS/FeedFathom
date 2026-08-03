import { expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import { HttpClient, HttpDeferredError } from "../src/lib/http-client.ts";
import {
  createNativeHttpTransport,
  HttpPolicyError,
  type NativeHttpResponse,
  type NativeHttpTransport,
} from "../src/lib/http-native-transport.ts";

const maximumBodyBytes = 5 * 1024 * 1024;

const redis = () => {
  const values = new Map<string, string>();
  const deleted: string[] = [];
  return {
    deleted,
    async decr(key: string) {
      const value = String(Number(values.get(key) ?? "0") - 1);
      values.set(key, value);
      return Number(value);
    },
    async del(key: string) {
      deleted.push(key);
      values.delete(key);
      return 1;
    },
    async expire() {
      return 1;
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async incr(key: string) {
      const value = String(Number(values.get(key) ?? "0") + 1);
      values.set(key, value);
      return Number(value);
    },
    async set(key: string, value: string, ...options: Array<number | string>) {
      if (options.includes("NX") && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    values,
  };
};

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
            status: 429,
            headers:
              retryAfter === undefined ? {} : { "retry-after": retryAfter },
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
    async lookup(hostname) {
      lookupHostname = hostname;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    async dispatch(request) {
      expect(request.address).toBe("93.184.216.34");
      expect(request.family).toBe(4);
      expect(request.headers.get("host")).toBe("feeds.example.com:8443");
      expect(request.port).toBe(8443);
      expect(request.servername).toBe("feeds.example.com");
      return nativeResponse("feed", { url: request.url });
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
      async lookup() {
        lookups++;
        return answers;
      },
      async dispatch() {
        dispatches++;
        return nativeResponse("unexpected");
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
    async lookup(hostname) {
      lookedUp.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    },
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
      async lookup() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
      async dispatch(request) {
        return nativeResponse("redirect", {
          headers: location === undefined ? {} : { location },
          onDestroy: () => destroyed++,
          status: 302,
          url: request.url,
        });
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

test("accepts exactly 5 MiB and rejects one decoded byte over", async () => {
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
    "exceeds 5 MiB",
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

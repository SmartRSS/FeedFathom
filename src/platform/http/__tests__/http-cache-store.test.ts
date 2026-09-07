import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { HttpClient } from "#platform/http/http-client.ts";
import {
  type NativeHttpResponse,
  type NativeHttpTransport,
} from "#platform/http/http-native-transport.ts";

const maximumBodyBytes = 24 * 1024 * 1024;

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

function queuedTransport(responses: NativeHttpResponse[]): NativeHttpTransport {
  return async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected HTTP request");
    return response;
  };
}

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

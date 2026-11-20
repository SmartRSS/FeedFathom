import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { HttpClient } from "#platform/http/http-client.ts";
import { buildUserAgent } from "#platform/http/identity.ts";
import {
  type NativeHttpResponse,
  type NativeHttpTransport,
} from "#platform/http/http-native-transport.ts";

const redis = () => ({
  async del() {
    return 1;
  },
  async get() {
    return null;
  },
  async send() {
    return null;
  },
  async set() {
    return "OK";
  },
});

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

test("buildUserAgent appends the subscriber clause only for a real count", () => {
  const prefix =
    "SmartRSS/FeedFathom (+https://github.com/SmartRSS/FeedFathom; instance=localhost";
  expect(buildUserAgent(prefix, undefined)).toBe(`${prefix})`);
  expect(buildUserAgent(prefix, 0)).toBe(`${prefix}; 0 subscribers)`);
  expect(buildUserAgent(prefix, -1)).toBe(`${prefix})`);
  expect(buildUserAgent(prefix, Number.NaN)).toBe(`${prefix})`);
  expect(buildUserAgent(prefix, 1.5)).toBe(`${prefix})`);
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
    version: "1cdfc8be7223fa79a5025049681dca6f98439113",
  };

  await new HttpClient(redis(), deployed).get("https://a.example/feed", {
    subscribers: 4,
  });
  await new HttpClient(redis(), deployed).get("https://b.example/feed", {
    subscribers: 1,
  });
  await new HttpClient(redis(), deployed).get("https://c.example/feed");
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

  await new HttpClient(redis(), { transport }).get("https://a.example/feed", {
    subscribers: 2,
  });
  await new HttpClient(redis(), {
    instance: "feeds.example.com:8443",
    transport,
    version: "staging",
  }).get("https://b.example/feed", { subscribers: 2 });
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

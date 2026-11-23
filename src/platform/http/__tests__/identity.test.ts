import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { HttpClient } from "#platform/http/http-client.ts";
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

  const counts = [4, 1, 0, undefined, Number.NaN, -1, 1.5];
  for (const [index, subscribers] of counts.entries()) {
    // eslint-disable-next-line no-await-in-loop -- Requests are recorded in order.
    await new HttpClient(redis(), deployed).get(
      `https://feed${index}.example/feed`,
      subscribers === undefined ? {} : { subscribers },
    );
  }

  const product =
    "SmartRSS/FeedFathom/1cdfc8b (+https://github.com/SmartRSS/FeedFathom; instance=feeds.example.com";
  expect(sent).toEqual([
    `${product}; 4 subscribers)`,
    `${product}; 1 subscribers)`,
    `${product}; 0 subscribers)`,
    `${product})`,
    `${product})`,
    `${product})`,
    `${product})`,
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

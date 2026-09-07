import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { HttpClient } from "#platform/http/http-client.ts";
import { buildUserAgent } from "#platform/http/identity.ts";
import {
  type NativeHttpResponse,
  type NativeHttpTransport,
} from "#platform/http/http-native-transport.ts";

const redis = () => ({
  async decr() {
    return 0;
  },
  async del() {
    return 1;
  },
  async expire() {
    return 1;
  },
  async get() {
    return null;
  },
  async incr() {
    return 0;
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

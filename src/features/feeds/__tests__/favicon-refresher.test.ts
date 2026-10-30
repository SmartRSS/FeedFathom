import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Readable } from "node:stream";
import { HttpClient } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import {
  FaviconRefresher,
  faviconDeferralHorizonMs,
} from "#features/feeds/favicon-refresher.ts";

afterEach(() => {
  setSystemTime();
});

// A 16 px ICO header: what DuckDuckGo serves, and enough for imageDimensions.
const smallIco = Buffer.alloc(22);
smallIco.writeUInt16LE(1, 2);
smallIco[6] = 16;
smallIco[7] = 16;

const png64 = Buffer.alloc(24);
png64.write("\x89PNG", 0, "latin1");
png64.writeUInt32BE(64, 16);
png64.writeUInt32BE(64, 20);

const exampleSource = {
  firstRunAt: Date.now(),
  homeUrl: "https://example.com/",
  id: 1,
};

function refresherAnswering(
  answer: (url: string) => [number, HeadersInit, Buffer?],
) {
  const requested: string[] = [];
  const updated: number[] = [];
  const redis = createFakeHttpRedis();
  const client = new HttpClient(redis, {
    deadlineMs: 2_000,
    transport: async (url) => {
      requested.push(url);
      const [status, headers, data = Buffer.alloc(0)] = answer(url);
      const body = Readable.from([data]);
      return {
        body,
        destroy: () => body.destroy(),
        headers: new Headers(headers),
        status,
        url,
      };
    },
  });
  const refresher = new FaviconRefresher(
    client,
    {
      async updateFavicon(id) {
        updated.push(id);
      },
    },
    redis,
  );
  return { refresher, requested, updated };
}

test("encodes the home URL into the provider query string", async () => {
  const { refresher, requested } = refresherAnswering(() => [404, {}]);
  await refresher.refreshFavicon({
    firstRunAt: Date.now(),
    homeUrl: "https://example.com/blog?a=1&b=2",
    id: 1,
  });

  const gstatic = new URL(
    requested.find((url) => url.includes("gstatic")) ?? "",
  );
  expect(gstatic.searchParams.get("url")).toBe(
    "https://example.com/blog?a=1&b=2",
  );
  expect(gstatic.searchParams.get("size")).toBe("64");
  expect(requested).toContain(
    "https://favicon.im/example.com?throw-error-on-404=true",
  );
});

test("falls back to unavatar only after every primary provider missed", async () => {
  const { refresher, requested, updated } = refresherAnswering(() => [404, {}]);
  await refresher.refreshFavicon(exampleSource);

  expect(requested.some((url) => url.includes("unavatar"))).toBe(true);
  expect(updated).toEqual([]);
});

test("a deferred provider keeps the stored icon instead of a smaller one", async () => {
  const { refresher, updated } = refresherAnswering((url) =>
    url.includes("gstatic")
      ? [429, { "retry-after": "60" }]
      : [200, { "content-type": "image/x-icon" }, smallIco],
  );
  const error = await refresher
    .refreshFavicon(exampleSource)
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(HttpDeferredError);
  expect(updated).toEqual([]);
});

test("defers to the latest primary retry time without unavatar, one slot after the last deferral", async () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  setSystemTime(now);
  const { refresher, requested } = refresherAnswering((url) => [
    429,
    { "retry-after": url.includes("favicon.im") ? "120" : "60" },
  ]);
  const retryAt = async (id: number) => {
    const error = await refresher
      .refreshFavicon({ ...exampleSource, firstRunAt: now, id })
      .catch((caught: unknown) => caught);
    if (!(error instanceof HttpDeferredError)) throw new Error("Not deferred");
    return error.retryAt;
  };

  // The first waits for the latest provider, favicon.im; the second, blocked
  // by the same providers, queues one interval plus slack behind it.
  expect(await retryAt(1)).toBe(now + 120_000);
  expect(await retryAt(2)).toBe(now + 120_000 + 12_000);
  expect(requested.some((url) => url.includes("unavatar"))).toBe(false);
});

test("an icon at exactly the target size does not wait for a deferred provider", async () => {
  const { refresher, updated } = refresherAnswering((url) =>
    url.includes("gstatic")
      ? [200, { "content-type": "image/png" }, png64]
      : [429, { "retry-after": "60" }],
  );
  await refresher.refreshFavicon(exampleSource);

  expect(updated).toEqual([1]);
});

test("a provider blocked past the horizon counts as a miss", async () => {
  const { refresher, requested, updated } = refresherAnswering((url) =>
    url.includes("gstatic")
      ? [429, { "retry-after": String(faviconDeferralHorizonMs / 1_000 + 60) }]
      : [200, { "content-type": "image/x-icon" }, smallIco],
  );
  await refresher.refreshFavicon(exampleSource);

  expect(updated).toEqual([1]);
  expect(requested.some((url) => url.includes("unavatar"))).toBe(false);
});

test("past the horizon, the limiter's own pacing still defers", async () => {
  const { refresher, requested } = refresherAnswering(() => [404, {}]);
  // Takes every provider's interval, so the next refresh is paced.
  await refresher.refreshFavicon(exampleSource);
  requested.length = 0;
  const error = await refresher
    .refreshFavicon({
      ...exampleSource,
      firstRunAt: Date.now() - faviconDeferralHorizonMs - 1,
      id: 2,
    })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(HttpDeferredError);
  expect(requested).toEqual([]);
});

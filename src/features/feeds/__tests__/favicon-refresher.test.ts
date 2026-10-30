import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Readable } from "node:stream";
import { HttpClient } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import {
  FaviconRefresher,
  faviconDeferralHorizonMs,
  faviconRefreshBackstopMs,
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
  await refresher.refreshFavicon({ ...exampleSource });

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
    .refreshFavicon({ ...exampleSource, hasFavicon: true })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(HttpDeferredError);
  expect(updated).toEqual([]);
});

test("a source without an icon stores the best one so far while a provider defers", async () => {
  const { refresher, updated } = refresherAnswering((url) =>
    url.includes("gstatic")
      ? [429, { "retry-after": "60" }]
      : [200, { "content-type": "image/x-icon" }, smallIco],
  );
  const source = { ...exampleSource, hasFavicon: false };
  const error = await refresher
    .refreshFavicon(source)
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(HttpDeferredError);
  expect(updated).toEqual([1]);
  // Written back into the job data, so the retry does not downgrade it.
  expect(source.hasFavicon).toBe(true);
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
  await refresher.refreshFavicon({ ...exampleSource });

  expect(updated).toEqual([1]);
});

test("a provider blocked past the horizon counts as a miss", async () => {
  const { refresher, requested, updated } = refresherAnswering((url) =>
    url.includes("gstatic")
      ? [429, { "retry-after": String(faviconDeferralHorizonMs / 1_000 + 60) }]
      : [200, { "content-type": "image/x-icon" }, smallIco],
  );
  await refresher.refreshFavicon({ ...exampleSource });

  expect(updated).toEqual([1]);
  expect(requested.some((url) => url.includes("unavatar"))).toBe(false);
});

test("past the horizon, the limiter's own pacing still defers", async () => {
  const { refresher, requested } = refresherAnswering(() => [404, {}]);
  // Takes every provider's interval, so the next refresh is paced.
  await refresher.refreshFavicon({ ...exampleSource });
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

test("the horizon starts at the first block, not at the first run", async () => {
  const { refresher, updated } = refresherAnswering((url) =>
    url.includes("gstatic")
      ? [429, { "retry-after": "60" }]
      : [200, { "content-type": "image/x-icon" }, smallIco],
  );
  // Paced in the queue for longer than the horizon, then blocked.
  const source: Parameters<FaviconRefresher["refreshFavicon"]>[0] = {
    ...exampleSource,
    firstRunAt: Date.now() - faviconDeferralHorizonMs - 60_000,
    hasFavicon: true,
  };
  const error = await refresher
    .refreshFavicon(source)
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(HttpDeferredError);
  expect(updated).toEqual([]);
  expect(source.deferredSince).toBeGreaterThan(source.firstRunAt);
});

test("a short origin Retry-After still counts against the horizon", async () => {
  const { refresher, updated } = refresherAnswering((url) =>
    url.includes("gstatic")
      ? [429, { "retry-after": "5" }]
      : [200, { "content-type": "image/x-icon" }, smallIco],
  );
  await refresher.refreshFavicon({
    ...exampleSource,
    deferredSince: Date.now() - faviconDeferralHorizonMs,
    hasFavicon: true,
  });

  expect(updated).toEqual([1]);
});

test("past the backstop, even the limiter's pacing is a miss", async () => {
  const { refresher, requested } = refresherAnswering(() => [404, {}]);
  // Takes every provider's interval, unavatar's included.
  await refresher.refreshFavicon({ ...exampleSource });
  requested.length = 0;

  // Every provider is paced, so the job completes instead of deferring.
  expect(
    await refresher.refreshFavicon({
      ...exampleSource,
      firstRunAt: Date.now() - faviconRefreshBackstopMs - 1,
      id: 2,
    }),
  ).toBeUndefined();
  expect(requested).toEqual([]);
});

test("a block on one provider host does not queue jobs waiting on the others", async () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  setSystemTime(now);
  const { refresher } = refresherAnswering((url) =>
    url.includes("unavatar") ? [429, { "retry-after": "3600" }] : [404, {}],
  );
  const retryAt = async (id: number) => {
    const error = await refresher
      .refreshFavicon({ ...exampleSource, firstRunAt: now, id })
      .catch((caught: unknown) => caught);
    if (!(error instanceof HttpDeferredError)) throw new Error("Not deferred");
    return error.retryAt;
  };

  // The first misses every primary and waits an hour on unavatar; the
  // second is paced by the primaries, and queues on their hosts only.
  expect(await retryAt(1)).toBe(now + 3_600_000);
  expect(await retryAt(2)).toBeLessThanOrEqual(now + 12_000);
});

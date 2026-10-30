import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Readable } from "node:stream";
import { HttpClient } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";

afterEach(() => {
  setSystemTime();
});

// A 16 px ICO header: what DuckDuckGo serves, and enough for imageDimensions.
const smallIco = Buffer.alloc(22);
smallIco.writeUInt16LE(1, 2);
smallIco[6] = 16;
smallIco[7] = 16;

function refresherAnswering(
  answer: (url: string) => [number, HeadersInit, Buffer?],
) {
  const requested: string[] = [];
  const updated: number[] = [];
  const client = new HttpClient(createFakeHttpRedis(), {
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
  const refresher = new FaviconRefresher(client, {
    async updateFavicon(id) {
      updated.push(id);
    },
  });
  return { refresher, requested, updated };
}

test("encodes the home URL into the provider query string", async () => {
  const { refresher, requested } = refresherAnswering(() => [404, {}]);
  await refresher.refreshFavicon({
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
  await refresher.refreshFavicon({ homeUrl: "https://example.com/", id: 1 });

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
    .refreshFavicon({ homeUrl: "https://example.com/", id: 1 })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(HttpDeferredError);
  expect(updated).toEqual([]);
});

test("defers to the latest primary retry time, staggered by source id, without unavatar", async () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  setSystemTime(now);
  const { refresher, requested } = refresherAnswering((url) => [
    429,
    { "retry-after": url.includes("favicon.im") ? "120" : "60" },
  ]);
  const error = await refresher
    .refreshFavicon({ homeUrl: "https://example.com/", id: 13 })
    .catch((caught: unknown) => caught);

  expect(requested.some((url) => url.includes("unavatar"))).toBe(false);
  if (!(error instanceof HttpDeferredError)) throw new Error("Not deferred");
  // Source 13 lands 3 s into the background interval after the latest
  // provider, favicon.im, clears.
  expect(error.retryAt).toBe(now + 120_000 + 3_000);
});

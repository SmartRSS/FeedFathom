import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { HttpClient } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";
import { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";

function refresherAnswering(answer: (url: string) => [number, HeadersInit]) {
  const requested: string[] = [];
  const client = new HttpClient(createFakeHttpRedis(), {
    deadlineMs: 2_000,
    transport: async (url) => {
      requested.push(url);
      const [status, headers] = answer(url);
      const body = Readable.from([""]);
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
    async updateFavicon() {
      throw new Error("No provider returned an icon");
    },
  });
  return { refresher, requested };
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

test("defers to the earliest retry time across both provider passes", async () => {
  const { refresher, requested } = refresherAnswering((url) => [
    429,
    { "retry-after": url.includes("unavatar") ? "600" : "60" },
  ]);
  const before = Date.now();
  const error = await refresher
    .refreshFavicon({ homeUrl: "https://example.com/", id: 1 })
    .catch((caught: unknown) => caught);

  expect(requested.some((url) => url.includes("unavatar"))).toBe(true);
  if (!(error instanceof HttpDeferredError)) throw new Error("Not deferred");
  expect(error.retryAt).toBeGreaterThanOrEqual(before + 60_000);
  expect(error.retryAt).toBeLessThan(before + 600_000);
});

import { afterAll, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { RedisClient } from "bun";
import { HttpClient } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { requireDisposableRedisUrl } from "#platform/__tests__/disposable-redis-url.ts";
import { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";

// The slot script against a real server: favicon-refresher.test.ts covers the
// queueing rules through the fake, which does not interpret the Lua.
const redis = new RedisClient(requireDisposableRedisUrl());
const providerHosts = [
  "t3.gstatic.com",
  "favicon.im",
  "icons.duckduckgo.com",
  "unavatar.io",
];

async function clearProviderState() {
  await Promise.all(
    providerHosts.flatMap((host) => [
      redis.del(`favicon-refresh-slot:${host}`),
      redis.del(`http-blocked:${host}`),
      redis.del(`http-last-request:${host}`),
    ]),
  );
}

beforeEach(clearProviderState);

afterAll(async () => {
  await clearProviderState();
  redis.close();
});

test("deferred refreshes take slots one gap apart on every host that deferred them", async () => {
  const client = new HttpClient(redis, {
    deadlineMs: 2_000,
    transport: async (url) => {
      const body = Readable.from([""]);
      return {
        body,
        destroy: () => body.destroy(),
        headers: new Headers({ "retry-after": "60" }),
        status: 429,
        url,
      };
    },
  });
  const refresher = new FaviconRefresher(
    client,
    {
      async updateFavicon() {
        throw new Error("Nothing answered");
      },
    },
    redis,
  );
  const retryAt = async (id: number) => {
    const error = await refresher
      .refreshFavicon({
        firstRunAt: Date.now(),
        homeUrl: "https://example.com/",
        id,
      })
      .catch((caught: unknown) => caught);
    if (!(error instanceof HttpDeferredError)) throw new Error("Not deferred");
    return error.retryAt;
  };

  const first = await retryAt(1);
  const second = await retryAt(2);
  expect(first).toBeGreaterThan(Date.now() + 55_000);
  expect(second).toBe(first + 12_000);

  // Every primary host holds the later slot until a gap after it; unavatar
  // was never asked.
  const slots = await Promise.all(
    providerHosts.map(async (host) => {
      const key = `favicon-refresh-slot:${host}`;
      return [await redis.get(key), await redis.pttl(key)] as const;
    }),
  );
  const expiresIn = second + 12_000 - Date.now();
  expect(slots.map(([slot]) => slot)).toEqual([
    String(second),
    String(second),
    String(second),
    null,
  ]);
  for (const [, ttl] of slots.slice(0, 3)) {
    expect(ttl).toBeGreaterThan(expiresIn - 1_000);
  }
});

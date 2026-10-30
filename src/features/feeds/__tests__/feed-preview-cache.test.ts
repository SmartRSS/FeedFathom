import { describe, expect, spyOn, test } from "bun:test";
import type { FeedPreview } from "#features/feeds/feed-mapper.ts";
import { FeedPreviewCache } from "#features/feeds/feed-preview-cache.ts";

class FakeRedis {
  readonly deleted: string[] = [];
  readonly setCalls: [string, string, "PX", number][] = [];
  readonly values = new Map<string, string>();
  failGet = false;
  failSet = false;

  async del(key: string): Promise<number> {
    this.deleted.push(key);
    return this.values.delete(key) ? 1 : 0;
  }

  async get(key: string): Promise<null | string> {
    if (this.failGet) throw new Error("Redis unavailable");
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    expiration: "PX",
    milliseconds: number,
  ): Promise<string> {
    if (this.failSet) throw new Error("Redis unavailable");
    this.setCalls.push([key, value, expiration, milliseconds]);
    this.values.set(key, value);
    return "OK";
  }
}

const feedUrl = "https://example.com/feed.xml?token=secret";
const publishedAt = new Date("2026-07-20T12:00:00.000Z");
const preview: FeedPreview = {
  articles: [
    {
      author: "Author",
      content: "Content",
      enclosures: [],
      guid: "article-guid",
      publishedAt,
      title: "Article",
      updatedAt: null,
      url: "https://example.com/article",
    },
  ],
  description: "Description",
  feedUrl,
  link: "https://example.com",
  title: "Feed",
};
const previewWire = {
  ...preview,
  articles: preview.articles.map((article) => ({
    ...article,
    publishedAt: article.publishedAt.getTime(),
  })),
};

describe("FeedPreviewCache", () => {
  test("stores previews for ten minutes and revives dates", async () => {
    const redis = new FakeRedis();
    const cache = new FeedPreviewCache(redis);

    await cache.save(7, feedUrl, preview);

    const call = redis.setCalls[0];
    if (!call) throw new Error("Preview was not cached");
    expect(call[0]).toStartWith("feed-preview:7:");
    expect(call[0]).not.toContain(feedUrl);
    expect(call[2]).toBe("PX");
    expect(call[3]).toBe(10 * 60_000);
    expect(await cache.get(7, feedUrl)).toEqual(preview);
    expect(
      (await cache.get(7, feedUrl))?.articles[0]?.publishedAt,
    ).toBeInstanceOf(Date);
  });

  test("revives a preview cached before enclosures and updatedAt", async () => {
    const redis = new FakeRedis();
    const cache = new FeedPreviewCache(redis);
    await cache.save(7, feedUrl, preview);
    const key = redis.setCalls[0]?.[0];
    if (!key) throw new Error("Preview was not cached");
    const {
      enclosures: _enclosures,
      updatedAt: _updatedAt,
      ...legacy
    } = previewWire.articles[0]!;
    redis.values.set(
      key,
      JSON.stringify({ ...previewWire, articles: [legacy] }),
    );

    expect((await cache.get(7, feedUrl))?.articles).toEqual([
      { ...preview.articles[0]!, enclosures: [], updatedAt: publishedAt },
    ]);
  });

  // Subscribe imports a truncated preview from this entry alone, without a
  // refetch, so everything it reads must survive: the final URL links resolve
  // against, the flag, and the full parsed feed -- authors, CAP fields it
  // renders and filters by, and item languages that tell shared ids apart.
  test("a truncated preview round-trips everything subscribe imports", async () => {
    const cache = new FeedPreviewCache(new FakeRedis());
    const item = {
      authors: [{ name: "Author" }, { name: null }],
      content: "<p>Body</p>",
      description: null,
      id: "item-1",
      published: publishedAt,
      title: "Article",
      updated: null,
      url: "https://example.com/article",
    };
    const cap = {
      areaDesc: "Central coastal zone",
      certainty: "Likely",
      event: "Yellow Wind warning",
      expires: "2026-10-06T09:00:00+00:00",
      msgType: "Alert",
      onset: "2026-10-05T23:00:00+00:00",
      severity: "Moderate",
      status: "Actual",
      urgency: "Expected",
    };
    const feed = {
      description: null,
      items: [
        item,
        { ...item, authors: [], cap, id: "alert", url: null },
        { ...item, id: "shared", language: "en-CA" },
        { ...item, id: "shared", language: "fr-CA" },
      ],
      title: "Feed",
      url: "https://example.com",
    };
    const saved = {
      ...preview,
      feed,
      finalUrl: "https://cdn.example/feed.xml",
      truncated: true,
    };

    await cache.save(7, feedUrl, saved);

    expect(await cache.get(7, feedUrl)).toEqual(saved);
  });

  test("isolates previews by user and exact URL", async () => {
    const redis = new FakeRedis();
    const cache = new FeedPreviewCache(redis);
    await cache.save(7, feedUrl, preview);

    expect(await cache.get(8, feedUrl)).toBeUndefined();
    expect(await cache.get(7, `${feedUrl}#other`)).toBeUndefined();
  });

  test("deletes malformed or mismatched cached previews", async () => {
    const entries = [
      "not-json",
      JSON.stringify({
        ...previewWire,
        articles: [{ ...previewWire.articles[0], publishedAt: null }],
      }),
      JSON.stringify({ ...previewWire, extra: true }),
      JSON.stringify({
        ...previewWire,
        feedUrl: "https://example.com/other.xml",
      }),
    ];
    await Promise.all(
      entries.map(async (entry) => {
        const redis = new FakeRedis();
        const cache = new FeedPreviewCache(redis);
        await cache.save(7, feedUrl, preview);
        const key = redis.setCalls[0]?.[0];
        if (!key) throw new Error("Preview was not cached");
        redis.values.set(key, entry);
        expect(await cache.get(7, feedUrl)).toBeUndefined();
        expect(redis.deleted).toEqual([key]);
      }),
    );
  });

  test("treats Redis errors as cache misses", async () => {
    const redis = new FakeRedis();
    const cache = new FeedPreviewCache(redis);
    redis.failGet = true;

    expect(await cache.get(7, feedUrl)).toBeUndefined();
  });

  test("a failed save still resolves, but leaves a trace", async () => {
    const redis = new FakeRedis();
    const cache = new FeedPreviewCache(redis);
    redis.failSet = true;
    const errors = spyOn(console, "error");

    try {
      await expect(cache.save(7, feedUrl, preview)).resolves.toBeUndefined();
      expect(errors).toHaveBeenCalledWith(
        `Failed to store feed preview for ${feedUrl}:`,
        expect.anything(),
      );
    } finally {
      errors.mockRestore();
    }
  });
});

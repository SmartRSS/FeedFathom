import { describe, expect, test } from "bun:test";
import type { FeedPreview } from "../src/lib/feed-mapper.ts";
import { FeedPreviewCache } from "../src/lib/feed-preview-cache.ts";

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
      guid: "article-guid",
      publishedAt,
      title: "Article",
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

  test("isolates previews by user and exact URL", async () => {
    const redis = new FakeRedis();
    const cache = new FeedPreviewCache(redis);
    await cache.save(7, feedUrl, preview);

    expect(await cache.get(8, feedUrl)).toBeUndefined();
    expect(await cache.get(7, `${feedUrl}#other`)).toBeUndefined();
  });

  test("deletes malformed cached entries", async () => {
    const redis = new FakeRedis();
    const cache = new FeedPreviewCache(redis);
    await cache.save(7, feedUrl, preview);
    const key = redis.setCalls[0]?.[0];
    if (!key) throw new Error("Preview was not cached");
    redis.values.set(key, "not-json");

    expect(await cache.get(7, feedUrl)).toBeUndefined();
    expect(redis.deleted).toEqual([key]);
  });

  test("deletes entries with non-finite timestamps or extra fields", async () => {
    const malformedEntries = [
      {
        ...previewWire,
        articles: [{ ...previewWire.articles[0], publishedAt: null }],
      },
      { ...previewWire, extra: true },
    ];

    await Promise.all(
      malformedEntries.map(async (entry) => {
        const redis = new FakeRedis();
        const cache = new FeedPreviewCache(redis);
        await cache.save(7, feedUrl, preview);
        const key = redis.setCalls[0]?.[0];
        if (!key) throw new Error("Preview was not cached");
        redis.values.set(key, JSON.stringify(entry));

        expect(await cache.get(7, feedUrl)).toBeUndefined();
        expect(redis.deleted).toEqual([key]);
      }),
    );
  });

  test("deletes entries with invalid fields or a different URL", async () => {
    const redis = new FakeRedis();
    const cache = new FeedPreviewCache(redis);
    await cache.save(7, feedUrl, preview);
    const key = redis.setCalls[0]?.[0];
    if (!key) throw new Error("Preview was not cached");
    redis.values.set(
      key,
      JSON.stringify({
        ...previewWire,
        feedUrl: "https://example.com/other.xml",
      }),
    );

    expect(await cache.get(7, feedUrl)).toBeUndefined();
    expect(redis.deleted).toEqual([key]);
  });

  test("treats Redis errors as cache misses", async () => {
    const redis = new FakeRedis();
    const cache = new FeedPreviewCache(redis);
    redis.failGet = true;

    expect(await cache.get(7, feedUrl)).toBeUndefined();

    redis.failSet = true;
    await expect(cache.save(7, feedUrl, preview)).resolves.toBeUndefined();
  });
});

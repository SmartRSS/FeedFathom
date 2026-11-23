import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import type { FeedPreview } from "#features/feeds/feed-mapper.ts";
import { FeedPreviewCache } from "#features/feeds/feed-preview-cache.ts";

class FakeRedis {
  readonly deleted: string[] = [];
  readonly expiresAt = new Map<string, number>();
  readonly failure = new Error("Redis unavailable");
  readonly values = new Map<string, string>();
  failGet = false;
  failSet = false;

  async del(key: string): Promise<number> {
    this.deleted.push(key);
    return this.values.delete(key) ? 1 : 0;
  }

  async get(key: string): Promise<null | string> {
    if (this.failGet) throw this.failure;
    if ((this.expiresAt.get(key) ?? Infinity) <= Date.now()) return null;
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _expiration: "PX",
    milliseconds: number,
  ): Promise<string> {
    if (this.failSet) throw this.failure;
    this.expiresAt.set(key, Date.now() + milliseconds);
    this.values.set(key, value);
    return "OK";
  }

  storedKey(): string {
    const [key] = this.values.keys();
    if (!key) throw new Error("Preview was not cached");
    return key;
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
  test("serves a preview for ten minutes and revives its dates", async () => {
    setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    try {
      const cache = new FeedPreviewCache(new FakeRedis());
      await cache.save(7, feedUrl, preview);

      setSystemTime(new Date("2026-07-20T12:09:59.999Z"));
      const cached = await cache.get(7, feedUrl);
      expect(cached).toEqual(preview);
      expect(cached?.articles[0]?.publishedAt).toBeInstanceOf(Date);

      setSystemTime(new Date("2026-07-20T12:10:00.000Z"));
      expect(await cache.get(7, feedUrl)).toBeUndefined();
    } finally {
      setSystemTime();
    }
  });

  test("keeps the feed URL and its secret out of the Redis key", async () => {
    const redis = new FakeRedis();
    await new FeedPreviewCache(redis).save(7, feedUrl, preview);

    expect(redis.storedKey()).not.toContain("secret");
  });

  test("revives a preview cached before enclosures and updatedAt", async () => {
    const redis = new FakeRedis();
    const cache = new FeedPreviewCache(redis);
    await cache.save(7, feedUrl, preview);
    const key = redis.storedKey();
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
        const key = redis.storedKey();
        redis.values.set(key, entry);
        expect(await cache.get(7, feedUrl)).toBeUndefined();
        expect(redis.deleted).toEqual([key]);
      }),
    );
  });

  test("a failed read is a cache miss that logs the Redis error", async () => {
    const redis = new FakeRedis();
    redis.failGet = true;
    using errors = spyOn(console, "error").mockImplementation(() => {});

    expect(await new FeedPreviewCache(redis).get(7, feedUrl)).toBeUndefined();
    expect(errors.mock.calls.flat()).toContain(redis.failure);
  });

  test("a failed save still resolves, and logs the Redis error", async () => {
    const redis = new FakeRedis();
    redis.failSet = true;
    using errors = spyOn(console, "error").mockImplementation(() => {});

    await expect(
      new FeedPreviewCache(redis).save(7, feedUrl, preview),
    ).resolves.toBeUndefined();
    expect(errors.mock.calls.flat()).toContain(redis.failure);
  });
});

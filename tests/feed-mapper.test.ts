import { describe, expect, test } from "bun:test";
import {
  mapFeedItemToArticle,
  mapFeedToPreview,
  type Source,
} from "../src/lib/feed-mapper.ts";

type FeedInput = Parameters<typeof mapFeedItemToArticle>[1];
type FeedItemInput = Parameters<typeof mapFeedItemToArticle>[0];

const mockRewriteLinks = (content: string): string => {
  return content;
};

const createMockFeed = (override: Partial<FeedInput> = {}): FeedInput => ({
  description: null,
  items: [],
  title: null,
  url: null,
  ...override,
});

const createMockFeedItem = (
  override: Partial<FeedItemInput> = {},
): FeedItemInput => ({
  authors: [],
  content: null,
  description: null,
  id: null,
  published: null,
  title: null,
  updated: null,
  url: null,
  ...override,
});

describe("mapFeedItemToArticle", () => {
  const mockSource: Source = {
    id: 1,
    url: "https://example.com/feed.xml",
  };

  const mockFeed = createMockFeed({
    description: "Feed description",
    title: "Feed Title",
    url: "https://example.com",
  });

  const fixedDate = new Date("2024-03-06T12:00:00Z");

  test("should map feed item with all fields present", () => {
    const mockItem = createMockFeedItem({
      authors: [{ name: "John Doe" }],
      content: "Test content",
      description: "Test description",
      id: "123",
      published: new Date("2024-03-06T12:00:00Z"),
      title: "Test Title",
      updated: new Date("2024-03-06T13:00:00Z"),
      url: "https://example.com/article",
    });

    const result = mapFeedItemToArticle(
      mockItem,
      mockFeed,
      mockSource,
      mockRewriteLinks,
    );

    expect(result).toEqual({
      author: "John Doe",
      content: "Test content",
      guid: "123",
      publishedAt: new Date("2024-03-06T12:00:00Z"),
      sourceId: 1,
      title: "Test Title",
      updatedAt: new Date("2024-03-06T13:00:00Z"),
      url: "https://example.com/article",
    });
  });

  test("should use fallbacks for missing fields", () => {
    const mockItem = createMockFeedItem();
    const result = mapFeedItemToArticle(
      mockItem,
      mockFeed,
      mockSource,
      mockRewriteLinks,
      fixedDate.getTime(),
    );

    expect(result).toEqual({
      author: "Feed Title",
      content: "",
      guid: expect.any(String),
      publishedAt: fixedDate,
      sourceId: 1,
      title: "Feed Title",
      updatedAt: null,
      url: "",
    });
  });

  test("should fallback to source URL when no other identifiers available", () => {
    const mockItem = createMockFeedItem();
    const emptyFeed = createMockFeed();

    const result = mapFeedItemToArticle(
      mockItem,
      emptyFeed,
      mockSource,
      mockRewriteLinks,
      fixedDate.getTime(),
    );

    expect(result).toEqual({
      author: "https://example.com/feed.xml",
      content: "",
      guid: expect.any(String),
      publishedAt: fixedDate,
      sourceId: 1,
      title: "https://example.com/feed.xml",
      updatedAt: null,
      url: "",
    });
  });

  test("should handle author fallback chain", () => {
    // When first author has no name, it should fall back to feed title
    const mockItem = createMockFeedItem({
      authors: [{ name: null }, { name: "Second Author" }],
    });

    const result = mapFeedItemToArticle(
      mockItem,
      mockFeed,
      mockSource,
      mockRewriteLinks,
    );

    expect(result.author).toBe("Feed Title");
  });

  test("should handle date precedence correctly", () => {
    const publishedDate = new Date("2024-03-06T12:00:00Z");
    const mockItem = createMockFeedItem({
      published: publishedDate,
      updated: null,
    });

    const result = mapFeedItemToArticle(
      mockItem,
      mockFeed,
      mockSource,
      mockRewriteLinks,
    );

    // updated should fall back to published
    expect(result.updatedAt).toEqual(publishedDate);
    expect(result.publishedAt).toEqual(publishedDate);
  });

  test("should generate consistent GUID for same content", () => {
    const content = {
      content: "Same content",
      description: "Same desc",
      title: "Same title",
    };

    const mockItem1 = createMockFeedItem(content);
    const mockItem2 = createMockFeedItem(content);

    const result1 = mapFeedItemToArticle(
      mockItem1,
      mockFeed,
      mockSource,
      mockRewriteLinks,
    );
    const result2 = mapFeedItemToArticle(
      mockItem2,
      mockFeed,
      mockSource,
      mockRewriteLinks,
    );

    expect(result1.guid).toBe(result2.guid);
  });

  test("should handle null content with description fallback", () => {
    const mockItem = createMockFeedItem({
      content: null,
      description: "fallback description",
    });

    const result = mapFeedItemToArticle(
      mockItem,
      mockFeed,
      mockSource,
      mockRewriteLinks,
    );

    expect(result.content).toBe("fallback description");
  });
});

describe("mapFeedToPreview", () => {
  test("should map feed with all fields present", () => {
    const mockFeed = createMockFeed({
      description: "Feed description",
      title: "Feed Title",
      url: "https://example.com",
    });

    const result = mapFeedToPreview(
      mockFeed,
      "https://example.com/feed.xml",
      mockRewriteLinks,
    );

    expect(result).toEqual({
      articles: [],
      description: "Feed description",
      feedUrl: "https://example.com/feed.xml",
      link: "https://example.com/",
      title: "Feed Title",
    });
  });

  test("should handle null fields", () => {
    const mockFeed = createMockFeed({
      description: null,
      title: null,
      url: null,
    });

    const result = mapFeedToPreview(
      mockFeed,
      "https://example.com/feed.xml",
      mockRewriteLinks,
    );

    expect(result).toEqual({
      articles: [],
      description: undefined,
      feedUrl: "https://example.com/feed.xml",
      link: undefined,
      title: "https://example.com/feed.xml",
    });
  });

  test("should handle partially undefined feed data", () => {
    const mockFeed = createMockFeed({
      description: "description",
      title: null,
    });

    const result = mapFeedToPreview(
      mockFeed,
      "https://example.com/feed.xml",
      mockRewriteLinks,
    );

    expect(result).toEqual({
      articles: [],
      description: "description",
      feedUrl: "https://example.com/feed.xml",
      link: undefined,
      title: "https://example.com/feed.xml",
    });
  });

  test("preserves preview article persistence fields", () => {
    const publishedAt = new Date("2024-03-06T12:00:00Z");
    const mockFeed = createMockFeed({
      description: null,
      items: [
        createMockFeedItem({
          authors: [{ name: "Author" }],
          content: "Article content",
          published: publishedAt,
          title: "Article title",
          url: "javascript:alert(1)",
        }),
      ],
      title: "Feed Title",
      url: "https://example.com",
    });

    const result = mapFeedToPreview(
      mockFeed,
      "https://example.com/feed.xml",
      (content, baseUrl) => `${content} from ${baseUrl}`,
      publishedAt.getTime(),
    );

    expect(result.articles).toEqual([
      {
        author: "Author",
        content: "Article content from javascript:alert(1)",
        guid: expect.any(String),
        publishedAt,
        title: "Article title",
        updatedAt: publishedAt,
        url: "",
      },
    ]);
  });
});

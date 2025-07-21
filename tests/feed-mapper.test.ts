import {
  mapFeedItemToArticle,
  mapFeedToPreview,
  type Source,
} from "../src/lib/feed-mapper";
import { type Feed } from "@rowanmanning/feed-parser/lib/feed/base";
import { type FeedItem } from "@rowanmanning/feed-parser/lib/feed/item/base";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const mockRewriteLinks = (content: string): string => {
  return content;
};

const createMockFeedItem = (override: Partial<FeedItem> = {}): FeedItem => {
  const base: Partial<FeedItem> = {
    authors: [],
    content: null,
    description: null,
    id: null,
    published: null,
    title: null,
    updated: null,
    url: null,
  };

  return { ...base, ...override } as FeedItem;
};

describe("mapFeedItemToArticle", () => {
  const mockSource: Source = {
    id: 1,
    url: "https://example.com/feed.xml",
  };

  const mockFeed = {
    description: "Feed description",
    title: "Feed Title",
    url: "https://example.com",
  } as Feed;

  const fixedDate = new Date("2024-03-06T12:00:00Z");
  const originalDateNow = Date.now;

  beforeEach(() => {
    // Mock Date.now() to return a fixed timestamp
    Date.now = () => {
      return fixedDate.getTime();
    };
  });

  afterEach(() => {
    // Restore the original Date.now
    Date.now = originalDateNow;
  });

  test("should map feed item with all fields present", () => {
    const mockItem = createMockFeedItem({
      authors: [{ email: null, name: "John Doe", url: null }],
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
    );

    expect(result).toEqual({
      author: "Feed Title",
      content: "",
      guid: expect.any(String),
      publishedAt: fixedDate,
      sourceId: 1,
      title: "Feed Title",
      updatedAt: fixedDate,
      url: "",
    });
  });

  test("should fallback to source URL when no other identifiers available", () => {
    const mockItem = createMockFeedItem();
    const emptyFeed = {
      description: null,
      title: null,
      url: null,
    } as Feed;

    const result = mapFeedItemToArticle(
      mockItem,
      emptyFeed,
      mockSource,
      mockRewriteLinks,
    );

    expect(result).toEqual({
      author: "https://example.com/feed.xml",
      content: "",
      guid: expect.any(String),
      publishedAt: fixedDate,
      sourceId: 1,
      title: "https://example.com/feed.xml",
      updatedAt: fixedDate,
      url: "",
    });
  });

  test("should handle author fallback chain", () => {
    // When first author has no name, it should fall back to feed title
    const mockItem = createMockFeedItem({
      authors: [
        { email: "test@example.com", name: null, url: null },
        { email: null, name: "Second Author", url: null },
      ],
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
    const mockFeed = {
      description: "Feed description",
      title: "Feed Title",
      url: "https://example.com",
    } as Feed;

    const result = mapFeedToPreview(mockFeed, "https://example.com/feed.xml");

    expect(result).toEqual({
      description: "Feed description",
      feedUrl: "https://example.com/feed.xml",
      link: "https://example.com",
      title: "Feed Title",
    });
  });

  test("should handle null fields", () => {
    const mockFeed = {
      description: null,
      title: null,
      url: null,
    } as Feed;

    const result = mapFeedToPreview(mockFeed, "https://example.com/feed.xml");

    expect(result).toEqual({
      description: undefined,
      feedUrl: "https://example.com/feed.xml",
      link: undefined,
      title: undefined,
    });
  });

  test("should handle partially undefined feed data", () => {
    const mockFeed = {
      description: "description",
      title: null,
      url: undefined,
    } as unknown as Feed;

    const result = mapFeedToPreview(mockFeed, "https://example.com/feed.xml");

    expect(result).toEqual({
      description: "description",
      feedUrl: "https://example.com/feed.xml",
      link: undefined,
      title: undefined,
    });
  });
});

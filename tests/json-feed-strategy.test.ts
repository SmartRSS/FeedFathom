import { describe, expect, it } from "bun:test";
import { JsonFeedStrategy } from "../src/lib/feed-strategies/json-feed-strategy.ts";

describe("JsonFeedStrategy", () => {
  const strategy = new JsonFeedStrategy();

  const baseResponse = {
    status: 200,
    statusText: "OK",
    headers: {},
    config: { 
      url: "https://example.com/feed.json",
      headers: {},
    },
    cached: false,
  };

  describe("parse", () => {
    it("should parse a valid JSON Feed", () => {
      const data = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Test Feed",
        homePageUrl: "https://example.com",
        description: "A test feed",
        items: [
          {
            id: "1",
            title: "Test Article",
            contentHtml: "<p>Test content</p>",
            url: "https://example.com/article1",
            datePublished: "2023-01-01T00:00:00Z",
            authors: [{ name: "Test Author" }],
          },
        ],
      });
      const result = strategy.parse({ 
        response: { ...baseResponse, data } as any, 
        sourceId: 1 
      });
      expect(result.feedInfo.title).toBe("Test Feed");
      expect(result.feedInfo.description).toBe("A test feed");
      expect(result.feedInfo.link).toBe("https://example.com");
      expect(result.articles).toHaveLength(1);
      expect(result.articles[0]?.title).toBe("Test Article");
      expect(result.articles[0]?.author).toBe("Test Author");
      expect(result.articles[0]?.content).toBe("<p>Test content</p>");
    });

    it("should handle JSON Feed with contentText instead of contentHtml", () => {
      const data = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Test Feed",
        items: [
          {
            id: "1",
            title: "Test Article",
            contentText: "Plain text content",
            url: "https://example.com/article1",
          },
        ],
      });
      const result = strategy.parse({ 
        response: { ...baseResponse, data } as any, 
        sourceId: 1 
      });
      expect(result.articles[0]?.content).toBe("Plain text content");
    });

    it("should handle JSON Feed with summary instead of content", () => {
      const data = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Test Feed",
        items: [
          {
            id: "1",
            title: "Test Article",
            summary: "Article summary",
            url: "https://example.com/article1",
          },
        ],
      });
      const result = strategy.parse({ 
        response: { ...baseResponse, data } as any, 
        sourceId: 1 
      });
      expect(result.articles[0]?.content).toBe("Article summary");
    });

    it("should handle JSON Feed with feed-level authors", () => {
      const data = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Test Feed",
        authors: [{ name: "Feed Author" }],
        items: [
          {
            id: "1",
            title: "Test Article",
            contentText: "Test content",
            url: "https://example.com/article1",
          },
        ],
      });
      const result = strategy.parse({ 
        response: { ...baseResponse, data } as any, 
        sourceId: 1 
      });
      expect(result.articles[0]?.author).toBe("Feed Author");
    });

    it("should handle JSON Feed with externalUrl", () => {
      const data = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Test Feed",
        items: [
          {
            id: "1",
            title: "Test Article",
            contentText: "Test content",
            externalUrl: "https://external.com/article1",
          },
        ],
      });
      const result = strategy.parse({ 
        response: { ...baseResponse, data } as any, 
        sourceId: 1 
      });
      expect(result.articles[0]?.url).toBe("https://external.com/article1");
    });

    it("should generate GUID from various sources", () => {
      const data = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Test Feed",
        items: [
          {
            id: "unique-id",
            title: "Test Article",
            contentText: "Test content",
          },
        ],
      });
      const result = strategy.parse({ 
        response: { ...baseResponse, data } as any, 
        sourceId: 1 
      });
      expect(result.articles[0]?.guid).toBe("unique-id");
    });

    it("should throw error for non-JSON Feed content", () => {
      const data = "<rss><channel><title>RSS Feed</title></channel></rss>";
      expect(() => strategy.parse({ 
        response: { ...baseResponse, data } as any, 
        sourceId: 1 
      })).toThrow("Content is not a valid JSON Feed");
    });

    it("should throw error for invalid JSON", () => {
      const data = "{ invalid json }";
      expect(() => strategy.parse({ 
        response: { ...baseResponse, data } as any, 
        sourceId: 1 
      })).toThrow("Content is not a valid JSON Feed");
    });

    it("should throw error for JSON without required fields", () => {
      const data = JSON.stringify({
        title: "Test Feed",
        // Missing version and items
      });
      expect(() => strategy.parse({ 
        response: { ...baseResponse, data } as any, 
        sourceId: 1 
      })).toThrow("Content is not a valid JSON Feed");
    });
  });
}); 
import { describe, expect, it } from "bun:test";
import { GenericFeedStrategy } from "../src/lib/feed-strategies/generic-feed-strategy.ts";

describe("GenericFeedStrategy", () => {
  const strategy = new GenericFeedStrategy();

  const rssContent = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test RSS Feed</title>
    <description>Test RSS Feed Description</description>
    <link>https://example.com</link>
    <item>
      <title>Test Article</title>
      <link>https://example.com/article</link>
      <description>Test article description</description>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

  const atomContent = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Atom Feed</title>
  <subtitle>Test Atom Feed Description</subtitle>
  <link href="https://example.com"/>
  <entry>
    <title>Test Article</title>
    <link href="https://example.com/article"/>
    <summary>Test article description</summary>
    <published>2024-01-01T12:00:00Z</published>
  </entry>
</feed>`;

  describe("parse", () => {
    it("should parse RSS feed correctly", () => {
      const mockResponse = {
        data: rssContent,
        config: { url: "https://example.com/feed.xml" },
        status: 200,
      } as any;

      const result = strategy.parse({
        response: mockResponse,
        sourceId: 1,
      });

      expect(result.feedInfo.title).toBe("Test RSS Feed");
      expect(result.feedInfo.description).toBe("Test RSS Feed Description");
      expect(result.feedInfo.link).toBe("https://example.com");
      expect(result.articles).toHaveLength(1);
      expect(result.articles[0]?.title).toBe("Test Article");
    });

    it("should parse Atom feed correctly", () => {
      const mockResponse = {
        data: atomContent,
        config: { url: "https://example.com/feed.xml" },
        status: 200,
      } as any;

      const result = strategy.parse({
        response: mockResponse,
        sourceId: 1,
      });

      expect(result.feedInfo.title).toBe("Test Atom Feed");
      expect(result.feedInfo.description).toBe("Test Atom Feed Description");
      expect(result.feedInfo.link).toBe("https://example.com");
      expect(result.articles).toHaveLength(1);
      expect(result.articles[0]?.title).toBe("Test Article");
    });

    it("should throw error for non-200 status", () => {
      const mockResponse = {
        data: rssContent,
        config: { url: "https://example.com/feed.xml" },
        status: 404,
      } as any;

      expect(() =>
        strategy.parse({
          response: mockResponse,
          sourceId: 1,
        }),
      ).toThrow();
    });
  });

  describe("getInfoOnly", () => {
    it("should return feed info for RSS feed", () => {
      const mockResponse = {
        data: rssContent,
        config: { url: "https://example.com/feed.xml" },
        status: 200,
      } as any;

      const result = strategy.getInfoOnly({ response: mockResponse });

      expect(result.feedInfo.title).toBe("Test RSS Feed");
      expect(result.feedInfo.description).toBe("Test RSS Feed Description");
      expect(result.feedInfo.link).toBe("https://example.com");
    });

    it("should return feed info for Atom feed", () => {
      const mockResponse = {
        data: atomContent,
        config: { url: "https://example.com/feed.xml" },
        status: 200,
      } as any;

      const result = strategy.getInfoOnly({ response: mockResponse });

      expect(result.feedInfo.title).toBe("Test Atom Feed");
      expect(result.feedInfo.description).toBe("Test Atom Feed Description");
      expect(result.feedInfo.link).toBe("https://example.com");
    });
  });

  describe("getArticlesOnly", () => {
    it("should return articles for RSS feed", () => {
      const mockResponse = {
        data: rssContent,
        config: { url: "https://example.com/feed.xml" },
        status: 200,
      } as any;

      const result = strategy.getArticlesOnly({
        response: mockResponse,
        sourceId: 1,
      });

      expect(result.articles).toHaveLength(1);
      expect(result.articles[0]?.title).toBe("Test Article");
      expect(result.articles[0]?.url).toBe("https://example.com/article");
    });

    it("should return articles for Atom feed", () => {
      const mockResponse = {
        data: atomContent,
        config: { url: "https://example.com/feed.xml" },
        status: 200,
      } as any;

      const result = strategy.getArticlesOnly({
        response: mockResponse,
        sourceId: 1,
      });

      expect(result.articles).toHaveLength(1);
      expect(result.articles[0]?.title).toBe("Test Article");
      expect(result.articles[0]?.url).toBe("https://example.com/article");
    });
  });
}); 
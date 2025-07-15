import { describe, expect, it } from "bun:test";
import { GenericFeedStrategy } from "../src/lib/feed-strategies/generic-feed-strategy.ts";
import { JsonFeedStrategy } from "../src/lib/feed-strategies/json-feed-strategy.ts";
import { FacebookFeedStrategy } from "../src/lib/feed-strategies/facebook-feed-strategy.ts";

describe("Feed Strategies", () => {
  describe("Rate Limiting Configuration", () => {
    it("should provide rate limit config for Facebook strategy", () => {
      const facebookStrategy = new FacebookFeedStrategy();
      const config = facebookStrategy.getRateLimitConfig();

      expect(config).toBeDefined();
      expect(config?.minDelayMs).toBe(60 * 1000); // 1 minute
      expect(config?.maxDelayMs).toBe(5 * 60 * 1000); // 5 minutes
      expect(config?.randomize).toBe(true);
    });

    it("should provide rate limit config for Generic strategy", () => {
      const genericStrategy = new GenericFeedStrategy();
      const config = genericStrategy.getRateLimitConfig();

      expect(config).toBeDefined();
      expect(config?.minDelayMs).toBe(30 * 1000); // 30 seconds
      expect(config?.maxDelayMs).toBe(2 * 60 * 1000); // 2 minutes
      expect(config?.randomize).toBe(true);
    });

    it("should not provide rate limit config for JSON strategy", () => {
      const jsonStrategy = new JsonFeedStrategy();
      // JSON strategy doesn't implement getRateLimitConfig
      expect("getRateLimitConfig" in jsonStrategy).toBe(false);
    });
  });

  describe("JsonFeedStrategy", () => {
    const jsonStrategy = new JsonFeedStrategy();

    const validJsonFeed = JSON.stringify({
      version: "https://jsonfeed.org/version/1",
      title: "Test Feed",
      items: [],
    });

    const invalidJson = "{ invalid json }";

    describe("parse", () => {
      it("should parse valid JSON feed", () => {
        const mockResponse = {
          data: validJsonFeed,
          config: { url: "https://example.com/feed.json" },
          status: 200,
        } as any;

        const result = jsonStrategy.parse({
          response: mockResponse,
          sourceId: 1,
        });

        expect(result.feedInfo.title).toBe("Test Feed");
        expect(result.articles).toEqual([]);
      });

      it("should throw error for invalid JSON feed", () => {
        const mockResponse = {
          data: invalidJson,
          config: { url: "https://example.com/feed.json" },
          status: 200,
        } as any;

        expect(() =>
          jsonStrategy.parse({
            response: mockResponse,
            sourceId: 1,
          }),
        ).toThrow();
      });
    });

    describe("getInfoOnly", () => {
      it("should return feed info for valid JSON feed", () => {
        const mockResponse = {
          data: validJsonFeed,
          config: { url: "https://example.com/feed.json" },
          status: 200,
        } as any;

        const result = jsonStrategy.getInfoOnly({ response: mockResponse });

        expect(result.feedInfo.title).toBe("Test Feed");
      });
    });
  });

  describe("GenericFeedStrategy", () => {
    const genericStrategy = new GenericFeedStrategy();

    const rssContent = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test RSS Feed</title>
    <item>
      <title>Test Article</title>
    </item>
  </channel>
</rss>`;

    const atomContent = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Atom Feed</title>
  <entry>
    <title>Test Article</title>
  </entry>
</feed>`;

    describe("parse", () => {
      it("should parse RSS feed", () => {
        const mockResponse = {
          data: rssContent,
          config: { url: "https://example.com/feed.xml" },
          status: 200,
        } as any;

        const result = genericStrategy.parse({
          response: mockResponse,
          sourceId: 1,
        });

        expect(result.feedInfo.title).toBe("Test RSS Feed");
        expect(result.articles).toHaveLength(1);
      });

      it("should parse Atom feed", () => {
        const mockResponse = {
          data: atomContent,
          config: { url: "https://example.com/feed.xml" },
          status: 200,
        } as any;

        const result = genericStrategy.parse({
          response: mockResponse,
          sourceId: 1,
        });

        expect(result.feedInfo.title).toBe("Test Atom Feed");
        expect(result.articles).toHaveLength(1);
      });
    });

    describe("getInfoOnly", () => {
      it("should return feed info for RSS feed", () => {
        const mockResponse = {
          data: rssContent,
          config: { url: "https://example.com/feed.xml" },
          status: 200,
        } as any;

        const result = genericStrategy.getInfoOnly({ response: mockResponse });

        expect(result.feedInfo.title).toBe("Test RSS Feed");
      });
    });
  });
}); 
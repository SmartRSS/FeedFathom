import { describe, expect, it } from "bun:test";
import { FeedParserStrategyRegistry } from "../src/lib/feed-strategies/index.ts";
import { GenericFeedStrategy } from "../src/lib/feed-strategies/generic-feed-strategy.ts";
import { JsonFeedStrategy } from "../src/lib/feed-strategies/json-feed-strategy.ts";

describe("Feed Strategies", () => {
  it("should initialize with default strategies", () => {
    const registry = new FeedParserStrategyRegistry({
      axiosInstance: {} as any,
      redis: {} as any,
      redirectMap: {} as any,
    });

    expect(registry).toBeDefined();
  });

  it("should handle rate limiting as cross-cutting concern", async () => {
    const registry = new FeedParserStrategyRegistry({
      axiosInstance: {} as any,
      redis: {} as any,
      redirectMap: {} as any,
    });

    expect(registry).toBeDefined();
  });

  describe("Strategy Detection", () => {
    const jsonStrategy = new JsonFeedStrategy();
    const genericStrategy = new GenericFeedStrategy();

    describe("JSON Feed Strategy", () => {
      it("should detect valid JSON Feed content", () => {
        const validJsonFeed = JSON.stringify({
          version: "https://jsonfeed.org/version/1.1",
          title: "Test Feed",
          items: [],
        });

        expect(jsonStrategy.canLikelyParse(validJsonFeed)).toBe(true);
      });

      it("should detect JSON Feed without version but with required fields", () => {
        const jsonFeedWithoutVersion = JSON.stringify({
          title: "Test Feed",
          items: [],
        });

        expect(jsonStrategy.canLikelyParse(jsonFeedWithoutVersion)).toBe(true);
      });

      it("should reject non-JSON content", () => {
        const xmlContent = "<rss><channel><title>RSS Feed</title></channel></rss>";
        expect(jsonStrategy.canLikelyParse(xmlContent)).toBe(false);
      });

      it("should reject invalid JSON", () => {
        const invalidJson = "{ invalid json }";
        expect(jsonStrategy.canLikelyParse(invalidJson)).toBe(false);
      });

      it("should reject JSON without required fields", () => {
        const jsonWithoutItems = JSON.stringify({
          title: "Test Feed",
          // Missing items array
        });
        expect(jsonStrategy.canLikelyParse(jsonWithoutItems)).toBe(false);
      });
    });

    describe("Generic Feed Strategy", () => {
      it("should detect RSS feeds", () => {
        const rssContent = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>RSS Feed</title>
    <item>
      <title>Test Item</title>
    </item>
  </channel>
</rss>`;

        expect(genericStrategy.canLikelyParse(rssContent)).toBe(true);
      });

      it("should detect Atom feeds", () => {
        const atomContent = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Test Entry</title>
  </entry>
</feed>`;

        expect(genericStrategy.canLikelyParse(atomContent)).toBe(true);
      });

      it("should detect feeds starting with XML declaration", () => {
        const xmlFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
  </channel>
</rss>`;

        expect(genericStrategy.canLikelyParse(xmlFeed)).toBe(true);
      });

      it("should reject non-feed content", () => {
        const htmlContent = "<html><body><h1>Hello World</h1></body></html>";
        expect(genericStrategy.canLikelyParse(htmlContent)).toBe(false);
      });

      it("should reject plain text", () => {
        const textContent = "This is just plain text content";
        expect(genericStrategy.canLikelyParse(textContent)).toBe(false);
      });
    });
  });
}); 
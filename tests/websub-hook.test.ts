import { describe, expect, it, mock } from "bun:test";
import { WebSubService } from "../src/lib/websub-service.ts";

// Mock dependencies
const mockAxiosInstance = {
  get: mock(() => Promise.resolve({ data: "", status: 200 })),
  post: mock(() => Promise.resolve({ status: 202 })),
} as any;

const mockRedis = {
  set: mock(() => Promise.resolve("OK")),
  get: mock(() => Promise.resolve(null)),
  del: mock(() => Promise.resolve(1)),
  keys: mock(() => Promise.resolve([])),
} as any;

const mockSourcesDataService = {
  findSourceById: mock(() => Promise.resolve({
    id: 1,
    url: "https://example.com/feed.xml",
    homeUrl: "https://example.com",
  })),
} as any;

describe("WebSub Hook Processing", () => {
  const webSubService = new WebSubService(
    mockAxiosInstance,
    mockRedis,
    mockSourcesDataService,
  );

  describe("handleContentNotification", () => {
    it("should process RSS feed content and store articles", async () => {
      const rssContent = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test RSS Feed</title>
    <link>https://example.com</link>
    <item>
      <title>Test Article</title>
      <link>https://example.com/article1</link>
      <description>Test article content</description>
      <pubDate>Mon, 01 Jan 2023 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

      // Mock the strategy registry to return parsed articles
      const mockStrategyRegistry = {
        parseWithDetection: mock(() => Promise.resolve({
          result: {
            articles: [{
              guid: "test-guid-1",
              title: "Test Article",
              url: "https://example.com/article1",
              content: "Test article content",
              author: "Test Author",
              publishedAt: new Date("Mon, 01 Jan 2023 00:00:00 GMT"),
              updatedAt: new Date("Mon, 01 Jan 2023 00:00:00 GMT"),
            }],
            feedInfo: {
              title: "Test RSS Feed",
              description: "Test feed",
              link: "https://example.com",
            },
          },
        })),
      };

      // Mock the container to return a mock articles data service
      const mockArticlesDataService = {
        batchUpsertArticles: mock(() => Promise.resolve()),
      };

      // Mock the imports
      mock.module("../src/lib/feed-strategies/index.ts", () => ({
        FeedParserStrategyRegistry: mock(() => mockStrategyRegistry),
      }));

      mock.module("../src/container.ts", () => ({
        default: {
          resolve: mock(() => mockArticlesDataService),
        },
      }));

      await webSubService.handleContentNotification(
        1,
        "application/rss+xml",
        rssContent,
      );

      // Verify that the source was looked up
      expect(mockSourcesDataService.findSourceById).toHaveBeenCalledWith(1);

      // Verify that articles were stored
      expect(mockArticlesDataService.batchUpsertArticles).toHaveBeenCalledWith([
        expect.objectContaining({
          guid: "test-guid-1",
          title: "Test Article",
          url: "https://example.com/article1",
          content: "Test article content",
          author: "Test Author",
          publishedAt: expect.any(Date),
          updatedAt: expect.any(Date),
          sourceId: 1,
          lastSeenInFeedAt: expect.any(Date),
        }),
      ]);
    });

    it("should handle Atom feed content", async () => {
      const atomContent = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Atom Feed</title>
  <link href="https://example.com"/>
  <entry>
    <title>Test Atom Article</title>
    <link href="https://example.com/atom-article"/>
    <content>Test atom article content</content>
    <published>2023-01-01T00:00:00Z</published>
  </entry>
</feed>`;

      // Mock the strategy registry
      const mockStrategyRegistry = {
        parseWithDetection: mock(() => Promise.resolve({
          result: {
            articles: [{
              guid: "atom-guid-1",
              title: "Test Atom Article",
              url: "https://example.com/atom-article",
              content: "Test atom article content",
              author: "Atom Author",
              publishedAt: new Date("2023-01-01T00:00:00Z"),
              updatedAt: new Date("2023-01-01T00:00:00Z"),
            }],
            feedInfo: {
              title: "Test Atom Feed",
              description: "Test atom feed",
              link: "https://example.com",
            },
          },
        })),
      };

      const mockArticlesDataService = {
        batchUpsertArticles: mock(() => Promise.resolve()),
      };

      mock.module("../src/lib/feed-strategies/index.ts", () => ({
        FeedParserStrategyRegistry: mock(() => mockStrategyRegistry),
      }));

      mock.module("../src/container.ts", () => ({
        default: {
          resolve: mock(() => mockArticlesDataService),
        },
      }));

      await webSubService.handleContentNotification(
        1,
        "application/atom+xml",
        atomContent,
      );

      expect(mockArticlesDataService.batchUpsertArticles).toHaveBeenCalledWith([
        expect.objectContaining({
          guid: "atom-guid-1",
          title: "Test Atom Article",
          url: "https://example.com/atom-article",
          content: "Test atom article content",
          author: "Atom Author",
          publishedAt: expect.any(Date),
          updatedAt: expect.any(Date),
          sourceId: 1,
          lastSeenInFeedAt: expect.any(Date),
        }),
      ]);
    });

    it("should reject unsupported content types", async () => {
      await expect(
        webSubService.handleContentNotification(
          1,
          "text/plain",
          "plain text content",
        ),
      ).rejects.toThrow("Unsupported content type: text/plain");
    });

    it("should handle missing source gracefully", async () => {
      mockSourcesDataService.findSourceById.mockResolvedValueOnce(null);

      await expect(
        webSubService.handleContentNotification(
          999,
          "application/rss+xml",
          "<rss><channel></channel></rss>",
        ),
      ).rejects.toThrow("Source 999 not found");
    });

    it("should handle empty article lists", async () => {
      const mockStrategyRegistry = {
        parseWithDetection: mock(() => Promise.resolve({
          result: {
            articles: [],
            feedInfo: {
              title: "Empty Feed",
              description: "No articles",
              link: "https://example.com",
            },
          },
        })),
      };

      const mockArticlesDataService = {
        batchUpsertArticles: mock(() => Promise.resolve()),
      };

      mock.module("../src/lib/feed-strategies/index.ts", () => ({
        FeedParserStrategyRegistry: mock(() => mockStrategyRegistry),
      }));

      mock.module("../src/container.ts", () => ({
        default: {
          resolve: mock(() => mockArticlesDataService),
        },
      }));

      await webSubService.handleContentNotification(
        1,
        "application/rss+xml",
        "<rss><channel></channel></rss>",
      );

      // Should not call batchUpsertArticles when no articles
      expect(mockArticlesDataService.batchUpsertArticles).not.toHaveBeenCalled();
    });

    it("should handle parsing errors gracefully", async () => {
      const mockStrategyRegistry = {
        parseWithDetection: mock(() => Promise.reject(new Error("Parse error"))),
      };

      mock.module("../src/lib/feed-strategies/index.ts", () => ({
        FeedParserStrategyRegistry: mock(() => mockStrategyRegistry),
      }));

      await expect(
        webSubService.handleContentNotification(
          1,
          "application/rss+xml",
          "<invalid>xml</invalid>",
        ),
      ).rejects.toThrow("Parse error");
    });
  });
}); 
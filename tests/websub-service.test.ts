import { describe, expect, it, mock } from "bun:test";
import { WebSubService } from "../src/lib/websub-service.ts";

describe("WebSub Service", () => {
  const mockAxiosInstance = {
    post: mock(() => Promise.resolve({ status: 202 })),
  } as any;

  const mockRedis = {
    set: mock(() => Promise.resolve("OK")),
    get: mock(() => Promise.resolve(null)),
    del: mock(() => Promise.resolve(1)),
    keys: mock(() => Promise.resolve([])),
  } as any;

  const mockSourcesDataService = {
    updateWebSubInfo: mock(() => Promise.resolve()),
  } as any;

  const webSubService = new WebSubService(
    mockAxiosInstance,
    mockRedis,
    mockSourcesDataService,
  );

  describe("WebSub Information Extraction", () => {
    it("should extract WebSub information from RSS feed", () => {
      const rssWithWebSub = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test RSS Feed</title>
    <link>https://example.com/feed</link>
    <atom:link href="https://example.com/hub" rel="hub"/>
    <atom:link href="https://example.com/feed" rel="self"/>
    <atom:link href="https://example.com/topic" rel="topic"/>
  </channel>
</rss>`;

      const webSubInfo = webSubService.extractWebSubInfo(rssWithWebSub);
      
      expect(webSubInfo).toEqual({
        hub: "https://example.com/hub",
        self: "https://example.com/feed",
        topic: "https://example.com/topic",
      });
    });

    it("should extract WebSub information from Atom feed", () => {
      const atomWithWebSub = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Atom Feed</title>
  <link href="https://example.com/feed" rel="self"/>
  <link href="https://example.com/hub" rel="hub"/>
</feed>`;

      const webSubInfo = webSubService.extractWebSubInfo(atomWithWebSub);
      
      expect(webSubInfo).toEqual({
        hub: "https://example.com/hub",
        self: "https://example.com/feed",
        topic: undefined,
      });
    });

    it("should return null for feeds without WebSub information", () => {
      const rssWithoutWebSub = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test RSS Feed</title>
    <link>https://example.com/feed</link>
  </channel>
</rss>`;

      const webSubInfo = webSubService.extractWebSubInfo(rssWithoutWebSub);
      
      expect(webSubInfo).toBeNull();
    });

    it("should handle malformed XML gracefully", () => {
      const malformedXml = "<invalid>xml<content>";
      
      const webSubInfo = webSubService.extractWebSubInfo(malformedXml);
      
      expect(webSubInfo).toBeNull();
    });
  });

  describe("WebSub Subscription Management", () => {
    it("should subscribe to a WebSub hub", async () => {
      const webSubInfo = {
        hub: "https://example.com/hub",
        self: "https://example.com/feed",
        topic: "https://example.com/topic",
      };

      await webSubService.subscribeToHub(webSubInfo, 1, "https://example.com");

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "https://example.com/hub",
        expect.stringMatching(/hub\.callback=https%3A%2F%2Fexample\.com%2Fapi%2Fwebsub%2Fcallback%2F1/),
        expect.objectContaining({
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }),
      );

      expect(mockRedis.set).toHaveBeenCalledWith(
        "websub:subscription:1",
        expect.stringContaining("sourceId"),
        "EX",
        86400,
      );

      expect(mockSourcesDataService.updateWebSubInfo).toHaveBeenCalledWith(1, webSubInfo);
    });

    it("should unsubscribe from a WebSub hub", async () => {
      const webSubInfo = {
        hub: "https://example.com/hub",
        self: "https://example.com/feed",
        topic: "https://example.com/topic",
      };

      await webSubService.unsubscribeFromHub(webSubInfo, 1, "https://example.com");

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "https://example.com/hub",
        expect.stringContaining("hub.mode=unsubscribe"),
        expect.objectContaining({
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }),
      );

      expect(mockRedis.del).toHaveBeenCalledWith("websub:subscription:1");
    });
  });

  describe("WebSub Verification", () => {
    it("should verify subscription challenges", async () => {
      const subscriptionData = JSON.stringify({
        sourceId: 1,
        hub: "https://example.com/hub",
        topic: "https://example.com/feed",
        callback: "https://example.com/api/websub/callback/1",
        leaseSeconds: 86400,
        secret: "test-secret",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
      });

      mockRedis.get.mockResolvedValueOnce(subscriptionData);

      const challenge = "test-challenge";
      const result = await webSubService.verifySubscription(
        1,
        "subscribe",
        "https://example.com/feed",
        challenge,
        86400,
      );

      expect(result).toBe(challenge);
    });

    it("should throw error for non-existent subscription", async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      await expect(
        webSubService.verifySubscription(1, "subscribe", "https://example.com/feed", "challenge"),
      ).rejects.toThrow("Subscription not found");
    });

    it("should throw error for topic mismatch", async () => {
      const subscriptionData = JSON.stringify({
        sourceId: 1,
        hub: "https://example.com/hub",
        topic: "https://example.com/feed",
        callback: "https://example.com/api/websub/callback/1",
        leaseSeconds: 86400,
        secret: "test-secret",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
      });

      mockRedis.get.mockResolvedValueOnce(subscriptionData);

      await expect(
        webSubService.verifySubscription(1, "subscribe", "https://example.com/wrong-topic", "challenge"),
      ).rejects.toThrow("Topic mismatch");
    });
  });
}); 
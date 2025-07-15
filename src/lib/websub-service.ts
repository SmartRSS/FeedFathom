import type { AxiosResponse } from "axios";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import type { RedisClient } from "bun";
import type { SourcesDataService } from "../db/data-services/source-data-service.ts";
import type { ParsedArticle } from "../types/feed-parser-types.ts";
import { logError } from "../util/log.ts";

export interface WebSubInfo {
  hub: string;
  self: string;
  topic?: string | undefined;
}

export interface WebSubSubscription {
  sourceId: number;
  hub: string;
  topic: string;
  callback: string;
  leaseSeconds?: number;
  secret?: string;
  createdAt: Date;
  expiresAt?: Date;
}

export class WebSubService {
  constructor(
    private readonly axiosInstance: AxiosCacheInstance,
    private readonly redis: RedisClient,
    private readonly sourcesDataService: SourcesDataService,
  ) {}

  /**
   * Extract WebSub information from a feed's XML content
   */
  public extractWebSubInfo(data: string): WebSubInfo | null {
    try {
      // Use regex to extract WebSub information from XML
      const hubMatch =
        data.match(
          /<link[^>]*rel=["']hub["'][^>]*href=["']([^"']+)["'][^>]*>/i,
        ) ||
        data.match(
          /<atom:link[^>]*rel=["']hub["'][^>]*href=["']([^"']+)["'][^>]*>/i,
        ) ||
        data.match(
          /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']hub["'][^>]*>/i,
        ) ||
        data.match(
          /<atom:link[^>]*href=["']([^"']+)["'][^>]*rel=["']hub["'][^>]*>/i,
        );
      const selfMatch =
        data.match(
          /<link[^>]*rel=["']self["'][^>]*href=["']([^"']+)["'][^>]*>/i,
        ) ||
        data.match(
          /<atom:link[^>]*rel=["']self["'][^>]*href=["']([^"']+)["'][^>]*>/i,
        ) ||
        data.match(
          /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']self["'][^>]*>/i,
        ) ||
        data.match(
          /<atom:link[^>]*href=["']([^"']+)["'][^>]*rel=["']self["'][^>]*>/i,
        );
      const topicMatch =
        data.match(
          /<link[^>]*rel=["']topic["'][^>]*href=["']([^"']+)["'][^>]*>/i,
        ) ||
        data.match(
          /<atom:link[^>]*rel=["']topic["'][^>]*href=["']([^"']+)["'][^>]*>/i,
        ) ||
        data.match(
          /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']topic["'][^>]*>/i,
        ) ||
        data.match(
          /<atom:link[^>]*href=["']([^"']+)["'][^>]*rel=["']topic["'][^>]*>/i,
        );

      const hub = hubMatch?.[1];
      const self = selfMatch?.[1];
      const topic = topicMatch?.[1];

      // If we found hub and self, it's a WebSub feed
      if (hub && self) {
        return { hub, self, topic: topic || undefined };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Subscribe to a WebSub hub for a source
   */
  public async subscribeToHub(
    webSubInfo: WebSubInfo,
    sourceId: number,
    baseUrl: string,
  ): Promise<void> {
    try {
      const callbackUrl = `${baseUrl}/api/websub/callback/${sourceId}`;
      const topic = webSubInfo.topic || webSubInfo.self;

      // Generate a secret for this subscription
      const secret = this.generateSecret();

      const payload = new URLSearchParams({
        "hub.callback": callbackUrl,
        "hub.mode": "subscribe",
        "hub.topic": topic,
        "hub.verify": "async",
        "hub.lease_seconds": "86400", // 24 hours
        "hub.secret": secret,
      });

      const response = await this.axiosInstance.post(
        webSubInfo.hub,
        payload.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: 10000,
        },
      );

      if (response.status !== 202 && response.status !== 204) {
        throw new Error(
          `WebSub subscription failed with status ${response.status}`,
        );
      }

      // Store subscription info in Redis for verification
      const subscriptionKey = `websub:subscription:${sourceId}`;
      const subscription: WebSubSubscription = {
        sourceId,
        hub: webSubInfo.hub,
        topic,
        callback: callbackUrl,
        leaseSeconds: 86400,
        secret,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400 * 1000),
      };

      await this.redis.set(
        subscriptionKey,
        JSON.stringify(subscription),
        "EX",
        86400,
      );

      // Update source with WebSub info
      await this.sourcesDataService.updateWebSubInfo(sourceId, webSubInfo);

      logError(`Successfully subscribed to WebSub hub for source ${sourceId}`);
    } catch (error) {
      logError(
        `Failed to subscribe to WebSub hub for source ${sourceId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Unsubscribe from a WebSub hub
   */
  public async unsubscribeFromHub(
    webSubInfo: WebSubInfo,
    sourceId: number,
    baseUrl: string,
  ): Promise<void> {
    try {
      const callbackUrl = `${baseUrl}/api/websub/callback/${sourceId}`;
      const topic = webSubInfo.topic || webSubInfo.self;

      const payload = new URLSearchParams({
        "hub.callback": callbackUrl,
        "hub.mode": "unsubscribe",
        "hub.topic": topic,
        "hub.verify": "async",
      });

      const response = await this.axiosInstance.post(
        webSubInfo.hub,
        payload.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: 10000,
        },
      );

      if (response.status !== 202 && response.status !== 204) {
        throw new Error(
          `WebSub unsubscription failed with status ${response.status}`,
        );
      }

      // Remove subscription from Redis
      const subscriptionKey = `websub:subscription:${sourceId}`;
      await this.redis.del(subscriptionKey);

      logError(
        `Successfully unsubscribed from WebSub hub for source ${sourceId}`,
      );
    } catch (error) {
      logError(
        `Failed to unsubscribe from WebSub hub for source ${sourceId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Verify a WebSub subscription challenge
   */
  public async verifySubscription(
    sourceId: number,
    mode: string,
    topic: string,
    challenge: string,
    leaseSeconds?: number,
  ): Promise<string> {
    try {
      const subscriptionKey = `websub:subscription:${sourceId}`;
      const subscriptionData = await this.redis.get(subscriptionKey);

      if (!subscriptionData) {
        throw new Error("Subscription not found");
      }

      const subscription = JSON.parse(subscriptionData) as WebSubSubscription;

      if (subscription.topic !== topic) {
        throw new Error("Topic mismatch");
      }

      if (mode === "subscribe") {
        // Update lease if provided
        if (leaseSeconds) {
          subscription.leaseSeconds = leaseSeconds;
          subscription.expiresAt = new Date(Date.now() + leaseSeconds * 1000);
          await this.redis.set(
            subscriptionKey,
            JSON.stringify(subscription),
            "EX",
            leaseSeconds,
          );
        }
      }

      return challenge;
    } catch (error) {
      logError(`WebSub verification failed for source ${sourceId}:`, error);
      throw error;
    }
  }

  /**
   * Handle a WebSub content notification
   */
  public async handleContentNotification(
    sourceId: number,
    contentType: string,
    content: string,
  ): Promise<void> {
    try {
      // Verify the content type
      if (
        !contentType.includes("application/atom+xml") &&
        !contentType.includes("application/rss+xml") &&
        !contentType.includes("application/xml")
      ) {
        throw new Error(`Unsupported content type: ${contentType}`);
      }

      // Get source information to determine the base URL for link rewriting
      const source = await this.sourcesDataService.findSourceById(sourceId);
      if (!source) {
        throw new Error(`Source ${sourceId} not found`);
      }

      // Create a mock response object for the feed parser strategy
      const mockResponse = {
        data: content,
        status: 200,
        statusText: "OK",
        headers: { "content-type": contentType },
        config: { url: source.url },
      } as unknown as AxiosResponse<string>;

      // Parse the feed content using the appropriate strategy
      const { articles } = await this.parseWebSubContent(
        mockResponse,
        sourceId,
        source.url,
      );

      if (articles.length > 0) {
        // Store the articles in the database
        await this.storeWebSubArticles(articles, sourceId);

        logError(
          `Successfully processed WebSub notification for source ${sourceId}: ${articles.length} articles stored`,
        );
      } else {
        logError(
          `WebSub notification for source ${sourceId} contained no articles`,
        );
      }
    } catch (error) {
      logError(
        `Failed to handle WebSub content notification for source ${sourceId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Parse WebSub content using the appropriate feed strategy
   */
  private async parseWebSubContent(
    _response: AxiosResponse<string>,
    sourceId: number,
    baseUrl: string,
  ): Promise<{ articles: ParsedArticle[] }> {
    try {
      // Import the strategy registry to detect and parse the feed
      const { FeedParserStrategyRegistry } = await import(
        "./feed-strategies/index.ts"
      );

      // Create a minimal context for the strategy registry
      const context = {
        axiosInstance: this.axiosInstance,
        redis: this.redis,
        redirectMap: new (await import("./redirect-map.ts")).RedirectMap(
          this.redis,
        ),
      };

      const strategyRegistry = new FeedParserStrategyRegistry(context);

      // Use the detection logic to parse the content
      const result = await strategyRegistry.parseWithDetection(
        baseUrl,
        sourceId,
      );

      return { articles: result.result.articles };
    } catch (error) {
      logError("Failed to parse WebSub content:", error);
      throw error;
    }
  }

  /**
   * Store WebSub articles in the database
   */
  private async storeWebSubArticles(
    articles: ParsedArticle[],
    sourceId: number,
  ): Promise<void> {
    try {
      // Use the existing articles data service from the container
      const container = await import("../container.ts");
      const articlesDataService = container.default.resolve(
        "articlesDataService",
      );

      // Convert parsed articles to database format
      const articlePayloads = articles.map((article) => ({
        guid: article.guid,
        title: article.title,
        url: article.url,
        content: article.content,
        author: article.author,
        publishedAt: article.publishedAt,
        updatedAt: article.updatedAt,
        sourceId: sourceId,
        lastSeenInFeedAt: new Date(),
      }));

      // Store articles using batch upsert
      await articlesDataService.batchUpsertArticles(articlePayloads);

      logError(
        `Successfully stored ${articlePayloads.length} WebSub articles for source ${sourceId}`,
      );
    } catch (error) {
      logError("Failed to store WebSub articles:", error);
      throw error;
    }
  }

  /**
   * Get all active WebSub subscriptions
   */
  public async getActiveSubscriptions(): Promise<WebSubSubscription[]> {
    try {
      const keys = await this.redis.keys("websub:subscription:*");
      const subscriptions: WebSubSubscription[] = [];

      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          const subscription = JSON.parse(data) as WebSubSubscription;
          if (subscription.expiresAt && subscription.expiresAt > new Date()) {
            subscriptions.push(subscription);
          }
        }
      }

      return subscriptions;
    } catch (error) {
      logError("Failed to get active WebSub subscriptions:", error);
      return [];
    }
  }

  /**
   * Clean up expired subscriptions
   */
  public async cleanupExpiredSubscriptions(): Promise<void> {
    try {
      const keys = await this.redis.keys("websub:subscription:*");

      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          const subscription = JSON.parse(data) as WebSubSubscription;
          if (subscription.expiresAt && subscription.expiresAt <= new Date()) {
            await this.redis.del(key);
            logError(
              `Cleaned up expired WebSub subscription for source ${subscription.sourceId}`,
            );
          }
        }
      }
    } catch (error) {
      logError("Failed to cleanup expired WebSub subscriptions:", error);
    }
  }

  private generateSecret(): string {
    return (
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    );
  }
}

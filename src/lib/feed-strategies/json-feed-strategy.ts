import type { AxiosResponse } from "axios";
import type { ParsedArticle } from "../../types/feed-parser-types.ts";
import type {
  ParsedFeedInfo,
  ParsedFeedResult,
} from "../../types/parsed-feed-result.ts";
import { logError as error } from "../../util/log.ts";
import { rewriteLinks } from "../rewrite-links.ts";
import type { FeedParserStrategy } from "./feed-parser-strategy.ts";

interface JsonFeed {
  version: string;
  title?: string;
  description?: string;
  home_page_url?: string;
  feed_url?: string;
  icon?: string;
  favicon?: string;
  language?: string;
  authors?: Array<{ name?: string; url?: string }>;
  items: JsonFeedItem[];
  // Support both snake_case and camelCase for compatibility
  homePageUrl?: string;
  feedUrl?: string;
}

interface JsonFeedItem {
  id?: string;
  url?: string;
  external_url?: string;
  title?: string;
  content_html?: string;
  content_text?: string;
  summary?: string;
  image?: string;
  bannerImage?: string;
  date_published?: string;
  date_modified?: string;
  authors?: Array<{ name?: string; url?: string }>;
  // Support both snake_case and camelCase for compatibility
  externalUrl?: string;
  contentHtml?: string;
  contentText?: string;
  datePublished?: string;
  dateModified?: string;
}

export class JsonFeedStrategy implements FeedParserStrategy {
  canLikelyParse(data: string): boolean {
    return this.isJsonFeedContent(data);
  }

  parse({
    response,
    sourceId,
  }: {
    response: AxiosResponse<string>;
    sourceId: number;
    originalUrl?: string;
  }): ParsedFeedResult {
    const fetchedUrl = response.config.url ?? "";
    this.validateJsonFeedResponse(response, fetchedUrl);

    if (!this.isJsonFeedContent(response.data)) {
      throw new Error("Content is not a valid JSON Feed");
    }

    const jsonFeed = this.parseJsonFeed(response.data);
    const now = new Date();
    const feedInfo = this.getInfo(jsonFeed, fetchedUrl);
    const articles = this.getArticles(jsonFeed, sourceId, fetchedUrl, now);
    return {
      feedInfo,
      articles,
    };
  }

  getInfoOnly({ response }: { response: AxiosResponse<string> }): {
    feedInfo: ParsedFeedInfo;
  } {
    const fetchedUrl = response.config.url ?? "";
    this.validateJsonFeedResponse(response, fetchedUrl);

    if (!this.isJsonFeedContent(response.data)) {
      throw new Error("Content is not a valid JSON Feed");
    }

    const jsonFeed = this.parseJsonFeed(response.data);
    return { feedInfo: this.getInfo(jsonFeed, fetchedUrl) };
  }

  getArticlesOnly({
    response,
    sourceId,
  }: {
    response: AxiosResponse<string>;
    sourceId: number;
  }): { articles: ParsedArticle[] } {
    const fetchedUrl = response.config.url ?? "";
    this.validateJsonFeedResponse(response, fetchedUrl);

    if (!this.isJsonFeedContent(response.data)) {
      throw new Error("Content is not a valid JSON Feed");
    }

    const jsonFeed = this.parseJsonFeed(response.data);
    const now = new Date();
    return { articles: this.getArticles(jsonFeed, sourceId, fetchedUrl, now) };
  }

  public parseJsonFeed(data: string): JsonFeed {
    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid JSON structure");
      }
      return parsed as JsonFeed;
    } catch (err) {
      throw new Error(
        `Failed to parse JSON Feed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Check if the content appears to be a JSON Feed
   */
  public isJsonFeedContent(data: string): boolean {
    try {
      const parsed = JSON.parse(data) as JsonFeed;
      if (!parsed || typeof parsed !== "object") {
        return false;
      }

      // Check for JSON Feed version 1 or 1.1
      if (
        parsed.version === "https://jsonfeed.org/version/1" ||
        parsed.version === "https://jsonfeed.org/version/1.1"
      ) {
        return true;
      }

      // Also accept feeds that have the required fields even without the exact version string
      return !!(parsed.title && Array.isArray(parsed.items));
    } catch {
      return false;
    }
  }

  private mapJsonFeedItemToArticle(
    item: JsonFeedItem,
    feed: JsonFeed,
    sourceId: number,
    fetchedUrl: string,
    now: Date,
  ): ParsedArticle {
    // Generate GUID from item ID or URL
    const guid =
      item.id ||
      item.url ||
      item.externalUrl ||
      item.external_url ||
      `${item.title}_${item.date_published}` ||
      `json_${Date.now()}`;

    // Get content (prefer contentHtml, fallback to contentText, then summary)
    const content =
      item.content_html ||
      item.contentHtml ||
      item.content_text ||
      item.contentText ||
      item.summary ||
      "";
    const processedContent = rewriteLinks(
      content,
      item.url || item.externalUrl || item.external_url || fetchedUrl,
    );

    // Get author (from item authors or feed authors)
    const author = this.getAuthor(item, feed);

    // Parse dates
    const publishedAt = item.date_published
      ? new Date(item.date_published)
      : now;
    const updatedAt = item.date_modified
      ? new Date(item.date_modified)
      : publishedAt;

    return {
      guid,
      sourceId,
      title: item.title || feed.title || "Untitled",
      url: item.url || item.externalUrl || item.external_url || fetchedUrl,
      author: author || "",
      publishedAt,
      content: processedContent,
      updatedAt,
      lastSeenInFeedAt: now,
    };
  }

  private getAuthor(item: JsonFeedItem, feed: JsonFeed): string {
    // Try item authors first
    if (item.authors && item.authors.length > 0) {
      const author = item.authors[0];
      if (author) {
        return author.name ?? author.url ?? "";
      }
    }

    // Fallback to feed authors
    if (feed.authors && feed.authors.length > 0) {
      const author = feed.authors[0];
      if (author) {
        return author.name ?? author.url ?? "";
      }
    }

    return "";
  }

  public getInfo(jsonFeed: JsonFeed, fetchedUrl: string): ParsedFeedInfo {
    return {
      title: jsonFeed.title ?? "",
      description: jsonFeed.description ?? undefined,
      link:
        (jsonFeed.home_page_url as string | undefined) ||
        jsonFeed.homePageUrl ||
        (jsonFeed.feed_url as string | undefined) ||
        jsonFeed.feedUrl ||
        fetchedUrl,
    };
  }

  public getArticles(
    jsonFeed: JsonFeed,
    sourceId: number,
    fetchedUrl: string,
    now: Date,
  ): ParsedArticle[] {
    return jsonFeed.items.map((item) =>
      this.mapJsonFeedItemToArticle(item, jsonFeed, sourceId, fetchedUrl, now),
    );
  }

  private validateJsonFeedResponse(
    response: AxiosResponse<string>,
    fetchedUrl: string,
  ): void {
    if (response.status !== 200) {
      error(`failed to load data for ${fetchedUrl}`);
      throw new Error(
        `Failed to load data for ${fetchedUrl}, received status ${response.status.toString()}`,
      );
    }
    if (typeof response.data !== "string") {
      error(`failed to load data for ${fetchedUrl}`);
      throw new Error(
        `Failed to load data for ${fetchedUrl}, unexpected payload type`,
      );
    }
  }
}

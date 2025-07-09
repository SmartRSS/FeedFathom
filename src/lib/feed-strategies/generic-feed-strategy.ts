import { parseFeed } from "@rowanmanning/feed-parser";
import type { Feed } from "@rowanmanning/feed-parser/lib/feed/base";
import type { FeedItem } from "@rowanmanning/feed-parser/lib/feed/item/base";
import type { AxiosResponse } from "axios";
import type { ParsedArticle } from "../../types/feed-parser-types.ts";
import type {
  ParsedFeedInfo,
  ParsedFeedResult,
} from "../../types/parsed-feed-result.ts";
import { logError as error } from "../../util/log.ts";
import { rewriteLinks } from "../rewrite-links.ts";
import type { FeedParserStrategy } from "./feed-parser-strategy.ts";

export class GenericFeedStrategy implements FeedParserStrategy {
  canLikelyParse(data: string): boolean {
    const trimmed = data.trim();

    // Check for XML-based feeds (RSS, Atom)
    if (
      trimmed.startsWith("<?xml") ||
      trimmed.startsWith("<rss") ||
      trimmed.startsWith("<feed")
    ) {
      return true;
    }

    // Check for common feed indicators
    const hasRssElements = /<rss[^>]*>|<channel[^>]*>|<item[^>]*>/i.test(
      trimmed,
    );
    const hasAtomElements = /<feed[^>]*>|<entry[^>]*>/i.test(trimmed);

    return hasRssElements || hasAtomElements;
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
    this.validateFeedResponse(response, fetchedUrl);

    // Parse the feed using the feed-parser library
    const parsedFeed = parseFeed(response.data);
    const now = new Date();
    const feedInfo = this.getInfo(parsedFeed);
    const articles = this.getArticles(parsedFeed, sourceId, fetchedUrl, now);
    return {
      feedInfo,
      articles,
    };
  }

  getInfoOnly({ response }: { response: AxiosResponse<string> }): {
    feedInfo: ParsedFeedInfo;
  } {
    const fetchedUrl = response.config.url ?? "";
    this.validateFeedResponse(response, fetchedUrl);
    const parsedFeed = parseFeed(response.data);
    return { feedInfo: this.getInfo(parsedFeed) };
  }

  getArticlesOnly({
    response,
    sourceId,
  }: {
    response: AxiosResponse<string>;
    sourceId: number;
  }): { articles: ParsedArticle[] } {
    const fetchedUrl = response.config.url ?? "";
    this.validateFeedResponse(response, fetchedUrl);
    const parsedFeed = parseFeed(response.data);
    const now = new Date();
    return {
      articles: this.getArticles(parsedFeed, sourceId, fetchedUrl, now),
    };
  }

  public getInfo(feed: Feed): ParsedFeedInfo {
    return {
      title: feed.title ?? "",
      description: feed.description ?? undefined,
      link: feed.url ?? "",
    };
  }

  public getArticles(
    feed: Feed,
    sourceId: number,
    fetchedUrl: string,
    now: Date,
  ): ParsedArticle[] {
    return feed.items.map((item) =>
      this.mapFeedItemToArticle(item, feed, sourceId, fetchedUrl, now),
    );
  }

  private mapFeedItemToArticle(
    item: FeedItem,
    feed: Feed,
    sourceId: number,
    fetchedUrl: string,
    now: Date,
  ): ParsedArticle {
    // Generate GUID from item ID or fallback to url/title/date
    const guid =
      item.id ||
      item.url ||
      `${item.title}_${item.published}` ||
      `rss_${Date.now()}`;

    // Get content (prefer content, fallback to description, then summary)
    const content =
      (item as { "content:encoded"?: string })["content:encoded"] ||
      item.content ||
      item.description ||
      item.title ||
      "";
    const processedContent = rewriteLinks(content, item.url || fetchedUrl);

    // Get author (from item or feed)
    const author = item.authors?.[0]?.name || feed.authors?.[0]?.name || "";

    // Parse dates
    const publishedAt = item.published ? new Date(item.published) : now;
    const updatedAt = item.updated ? new Date(item.updated) : publishedAt;

    return {
      guid,
      sourceId,
      title: item.title || feed.title || "Untitled",
      url: item.url || fetchedUrl,
      author,
      publishedAt,
      content: processedContent,
      updatedAt,
      lastSeenInFeedAt: now,
    };
  }

  private validateFeedResponse(
    response: { status: number; data: string },
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

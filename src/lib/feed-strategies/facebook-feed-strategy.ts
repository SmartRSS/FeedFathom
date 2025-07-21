import type { AxiosResponse } from "axios";
import type { ParsedArticle } from "../../types/feed-parser-types.ts";
import type {
  ParsedFeedInfo,
  ParsedFeedResult,
} from "../../types/parsed-feed-result.ts";
import { rewriteLinks } from "../rewrite-links.ts";
import type {
  FeedParserStrategy,
  RateLimitConfig,
} from "./feed-parser-strategy.ts";

export interface FacebookArticle {
  readonly title: string;
  readonly date: Date;
  readonly content: string;
}

/**
 * Normalizes a Facebook URL to include sorting parameter
 */
function normalizeFacebookUrl(url: string): string {
  return /[?&]sorting_setting=/.test(url)
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}sorting_setting=CHRONOLOGICAL`;
}

/**
 * Parses and unescapes text content from raw string
 */
function parseTextContent(rawText: string): string {
  const unescaped = rawText.replace(/\\"/g, '"').replace(/\\n/g, "\n");
  try {
    return JSON.parse(`"${rawText.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return unescaped;
  }
}

/**
 * Extracts timestamp from HTML context around a match
 */
function extractTimestamp(html: string, matchIndex: number): number {
  const after = html.slice(matchIndex, matchIndex + 500);
  const timestampMatch = after.match(/"timestamp"\s*:\s*(\d+)/);
  if (timestampMatch && timestampMatch.length > 1 && timestampMatch[1]) {
    return Number.parseInt(timestampMatch[1], 10) * 1000;
  }
  return Date.now();
}

/**
 * Creates a FacebookArticle from text content and timestamp
 */
function createFacebookArticle(
  textContent: string,
  timestamp: number,
): FacebookArticle {
  return {
    title:
      textContent.substring(0, 100) + (textContent.length > 100 ? "..." : ""),
    content: textContent,
    date: new Date(timestamp),
  };
}

/**
 * Extracts unique articles from HTML using regex pattern
 */
function extractArticlesFromHtml(html: string): readonly FacebookArticle[] {
  const seen = new Set<string>();
  const messageTextPattern =
    /"message"\s*:\s*\{[^{}]*?"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  const articles: FacebookArticle[] = [];

  for (
    let match = messageTextPattern.exec(html);
    match !== null;
    match = messageTextPattern.exec(html)
  ) {
    const rawText = match[1];
    if (!isString(rawText)) continue;

    const textContent = parseTextContent(rawText as string);
    if (textContent?.trim() && !seen.has(textContent)) {
      const timestamp = extractTimestamp(html, messageTextPattern.lastIndex);
      const article = createFacebookArticle(textContent, timestamp);

      articles.push(article);
      seen.add(textContent);
    }
  }

  return articles;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export class FacebookFeedStrategy implements FeedParserStrategy {
  getRateLimitConfig(): RateLimitConfig {
    return {
      minDelayMs: 60 * 1000, // 1 minute minimum
      maxDelayMs: 5 * 60 * 1000, // 5 minutes maximum
      randomize: true, // Randomize between 1-5 minutes
    };
  }

  async parse({
    response,
    sourceId,
  }: {
    response: AxiosResponse<string>;
    sourceId: number;
    originalUrl?: string;
  }): Promise<ParsedFeedResult> {
    const url = response.config.url ?? "";
    if (!url) {
      throw new Error("No URL provided in response");
    }
    // URL normalization is handled by the request handler
    normalizeFacebookUrl(url);

    // Use the response data directly since it was fetched with proper headers
    const facebookArticles = extractArticlesFromHtml(response.data);

    const now = new Date();
    const feedInfo = this.getFeedInfo(url);
    const articles = this.mapFacebookArticlesToParsedArticles(
      facebookArticles,
      sourceId,
      url,
      now,
    );

    return {
      feedInfo,
      articles,
    };
  }

  getInfoOnly({ response }: { response: AxiosResponse<string> }): {
    feedInfo: ParsedFeedInfo;
  } {
    const url = response.config.url ?? "";
    return {
      feedInfo: this.getFeedInfo(url),
    };
  }

  getArticlesOnly({
    response,
    sourceId,
  }: {
    response: AxiosResponse<string>;
    sourceId: number;
  }): Promise<{ articles: ParsedArticle[] }> {
    return this.parse({ response, sourceId }).then((result) => ({
      articles: result.articles,
    }));
  }

  private getFeedInfo(url: string): ParsedFeedInfo {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split("/").filter(Boolean);

      let title = "Facebook Feed";
      if (pathParts.length > 0) {
        if (pathParts[0] === "groups" && pathParts[1]) {
          title = `Facebook Group: ${pathParts[1]}`;
        } else if (pathParts[0] && pathParts[0] !== "pages") {
          title = `Facebook Page: ${pathParts[0]}`;
        }
      }

      return {
        title,
        description: "Facebook posts and updates",
        link: url,
      };
    } catch {
      return {
        title: "Facebook Feed",
        description: "Facebook posts and updates",
        link: url,
      };
    }
  }

  private mapFacebookArticlesToParsedArticles(
    facebookArticles: readonly FacebookArticle[],
    sourceId: number,
    fetchedUrl: string,
    now: Date,
  ): ParsedArticle[] {
    return facebookArticles.map((article, index) => {
      const guid = `facebook_${sourceId}_${article.date.getTime()}_${index}`;
      const processedContent = rewriteLinks(article.content, fetchedUrl);

      return {
        guid,
        sourceId,
        title: article.title,
        url: fetchedUrl,
        author: "Facebook User",
        publishedAt: article.date,
        content: processedContent,
        updatedAt: article.date,
        lastSeenInFeedAt: now,
      };
    });
  }
}

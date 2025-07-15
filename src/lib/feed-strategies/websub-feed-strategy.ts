import type { AxiosResponse } from "axios";
import { JSDOM } from "jsdom";
import type {
  ParsedFeedInfo,
  ParsedFeedResult,
} from "../../types/parsed-feed-result.ts";
import { scan } from "../scanner";
import type { FeedParserStrategy } from "./feed-parser-strategy.ts";

export class WebSubFeedStrategy implements FeedParserStrategy {
  public async parse(params: {
    response: AxiosResponse<string>;
    sourceId: number;
    originalUrl?: string;
  }): Promise<ParsedFeedResult> {
    // WebSub feeds are push-based, so we don't parse articles here
    // Articles will be received via webhook notifications
    return {
      articles: [],
      feedInfo: await this.getFeedInfoFromResponse(params.response),
    };
  }

  public async getInfoOnly(params: {
    response: AxiosResponse<string>;
  }): Promise<{ feedInfo: ParsedFeedInfo }> {
    return {
      feedInfo: await this.getFeedInfoFromResponse(params.response),
    };
  }

  public async getArticlesOnly(_params: {
    response: AxiosResponse<string>;
    sourceId: number;
  }): Promise<{ articles: never[] }> {
    // WebSub feeds don't parse articles - they receive them via webhook
    return { articles: [] };
  }

  private async getFeedInfoFromResponse(
    response: AxiosResponse<string>,
  ): Promise<ParsedFeedInfo> {
    try {
      const document = new JSDOM(response.data, { url: response.config.url });
      const scannedFeeds = await scan(
        response.config.url || "",
        document.window.document,
      );

      // Find the feed that matches our URL
      const matchingFeed = scannedFeeds.find(
        (feed) => feed.url === response.config.url,
      );

      if (matchingFeed?.webSub) {
        return {
          title: matchingFeed.title || "WebSub Feed",
          description: "WebSub-enabled feed",
          link: matchingFeed.webSub.self || response.config.url || "",
        };
      }

      // Fallback if no WebSub info found
      return {
        title: "WebSub Feed",
        description: "WebSub-enabled feed",
        link: response.config.url || "",
      };
    } catch (error) {
      throw new Error(`Failed to get WebSub feed info: ${error}`);
    }
  }
}

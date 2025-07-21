import type { AxiosRequestConfig } from "axios";
import type { FeedParserStrategy } from "./feed-parser-strategy.ts";

export interface StrategyDetectionResult {
  strategy: string;
  config?: AxiosRequestConfig | undefined;
  confidence: number; // 0-1, higher is more confident
}

export class StrategyDetectionService {
  constructor(private readonly strategies: FeedParserStrategy[]) {}

  /**
   * Detects the best strategy for a given URL
   */
  async detectStrategy(url: string): Promise<StrategyDetectionResult> {
    const candidates: Array<
      StrategyDetectionResult & { strategyInstance: FeedParserStrategy }
    > = [];

    // First, try URL-based detection (most reliable)
    for (const strategy of this.strategies) {
      const config = this.getStrategyConfig(strategy, url);
      if (config) {
        candidates.push({
          strategy: strategy.constructor.name,
          config,
          confidence: 0.9,
          strategyInstance: strategy,
        });
      }
    }

    // If no URL-based detection, try content-based detection
    if (candidates.length === 0) {
      // For now, we'll need to fetch content to detect
      // This could be optimized by storing detection results
      return {
        strategy: "GenericFeedStrategy",
        confidence: 0.5,
      };
    }

    // Return the highest confidence strategy
    const bestCandidate = candidates.sort(
      (a, b) => b.confidence - a.confidence,
    )[0];

    if (!bestCandidate) {
      return {
        strategy: "GenericFeedStrategy",
        confidence: 0.5,
      };
    }

    return {
      strategy: bestCandidate.strategy,
      config: bestCandidate.config,
      confidence: bestCandidate.confidence,
    };
  }

  /**
   * Gets custom request configuration for a strategy and URL
   */
  private getStrategyConfig(
    strategy: FeedParserStrategy,
    url: string,
  ): AxiosRequestConfig | undefined {
    const urlObj = new URL(url);

    // Facebook-specific configuration
    if (strategy.constructor.name === "FacebookFeedStrategy") {
      if (
        urlObj.hostname.includes("facebook.com") ||
        urlObj.hostname.includes("fb.com")
      ) {
        return {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            Connection: "keep-alive",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
          },
        };
      }
    }

    // WebSub-specific configuration
    if (strategy.constructor.name === "WebSubFeedStrategy") {
      return {
        headers: {
          Accept:
            "application/atom+xml, application/rss+xml, application/xml, text/xml",
        },
      };
    }

    // Default configuration for generic strategies
    return undefined;
  }

  /**
   * Determines if a URL is likely a newsletter (email-based)
   */
  isNewsletter(url: string): boolean {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Common newsletter platforms
    const newsletterDomains = [
      "mailchimp.com",
      "substack.com",
      "convertkit.com",
      "mailerlite.com",
      "sendinblue.com",
      "mailgun.com",
      "sendgrid.com",
      "campaignmonitor.com",
      "constantcontact.com",
      "aweber.com",
      "getresponse.com",
      "activecampaign.com",
      "klaviyo.com",
      "drip.com",
      "mailjet.com",
    ];

    return newsletterDomains.some((domain) => hostname.includes(domain));
  }

  /**
   * Determines if a URL is likely a WebSub hub
   */
  isWebSub(url: string): boolean {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Common WebSub hubs
    const websubHubs = [
      "websub.io",
      "websub.rocks",
      "websubhub.com",
      "pubsubhubbub.appspot.com",
      "superfeedr.com",
    ];

    return websubHubs.some((domain) => hostname.includes(domain));
  }

  /**
   * Gets the source type based on URL analysis
   */
  getSourceType(url: string): "feed" | "newsletter" | "websub" {
    if (this.isNewsletter(url)) {
      return "newsletter";
    }
    if (this.isWebSub(url)) {
      return "websub";
    }
    return "feed";
  }
}

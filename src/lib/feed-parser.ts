import crypto from "node:crypto";

import { parseFeed } from "@rowanmanning/feed-parser";
import type { Feed } from "@rowanmanning/feed-parser/lib/feed/base";
import type { Source } from "../types/source-types";
import { err, llog } from "../util/log";
import type { FeedItem } from "@rowanmanning/feed-parser/lib/feed/item/base";
import type { SourcesRepository } from "$lib/db/source-repository";
import type { ArticleRepository } from "$lib/db/article-repository";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import container from "../container";
import type Redis from "ioredis";
import * as cheerio from "cheerio";

const tagAttributePairs = [
  ["a", "href"],
  ["audio", "src"],
  ["video", "src"],
  ["video", "poster"],
  ["img", "src"],
  ["img", "srcset"],
  ["link", "href"],
  ["source", "src"],
  ["source", "srcset"],
  ["picture", "srcset"],
] as const;

const fixupLinks = (content: string, articleUrl: string) => {
  const $ = cheerio.load(content); // Load HTML content

  // Iterate through tag-attribute pairs
  tagAttributePairs.forEach(([tagName, attrName]) => {
    $(tagName).each((_index, element) => {
      const $elem = $(element);

      // Handle anchors <a> to add target="_blank"
      if (tagName === "a") {
        const hrefAttribute = $elem.attr(attrName);
        if (hrefAttribute) {
          try {
            const hrefUrl = new URL(hrefAttribute);
            // Ensure the protocol is valid
            if (["http:", "https:", "ftp:"].includes(hrefUrl.protocol)) {
              $elem.attr("target", "_blank");
            }
          } catch {
            // Ignore invalid URLs
          }
        }
      }

      // Process other attributes
      const attrValue = $elem.attr(attrName);
      if (attrValue) {
        if (attrName === "srcset") {
          // Special handling for "srcset"
          const processedSrcset = processSrcset(attrValue, articleUrl);
          $elem.attr(attrName, processedSrcset);
        } else {
          // General handling for src, href, etc.
          try {
            const absoluteUrl = new URL(attrValue, articleUrl).href;
            $elem.attr(attrName, absoluteUrl);
          } catch {
            console.error(
              `Invalid URL for ${tagName} (${attrName}): ${attrValue}`,
            );
          }
        }
      }
    });
  });

  // Serialize back the modified HTML
  return $.html();
};

// Helper to process "srcset" attributes
const processSrcset = (srcsetValue: string, baseUrl: string): string => {
  const paths = srcsetValue.split(",");
  const processedPaths = paths.map((path) => {
    const [url, width] = path.trim().split(/\s+/);
    if (!url) {
      return path; // Fall back to the original value if the URL is invalid
    }
    try {
      // Convert relative to absolute URL
      const absoluteUrl = new URL(url, baseUrl).href;
      return width ? `${absoluteUrl} ${width}` : absoluteUrl;
    } catch {
      console.error(`Invalid URL in srcset: ${url}`);
      return path;
    }
  });
  return processedPaths.join(", ");
};

export class FeedParser {
  private domainDelaySettings: Record<string, number> = {
    "openrss.org": 2500,
    "youtube.com": 500,
    "feeds.feedburner.com": 5000,
  };

  constructor(
    private readonly sourcesRepository: SourcesRepository,
    private readonly articlesRepository: ArticleRepository,
    private readonly axiosInstance: AxiosCacheInstance,
    private readonly redis: Redis,
  ) {}

  public async preview(sourceUrl: string) {
    try {
      const parsedFeed = await this.parseUrl(sourceUrl);
      if (!parsedFeed) {
        return;
      }
      return {
        title: parsedFeed.title,
        link: parsedFeed.url,
        description: parsedFeed.description,
        feedUrl: sourceUrl,
      };
    } catch {
      return;
    }
  }

  public async parseUrl(url: string): Promise<Feed | void> {
    const parserStrategies: Record<
      string,
      (url: string) => Promise<Feed | void>
    > = {};

    const sourceOrigin = new URL(url).origin;
    const chosenParser =
      parserStrategies[sourceOrigin] || this.parseGenericFeed;
    return await chosenParser.bind(this)(url);
  }

  public async parseSource(source: Source) {
    try {
      if (
        !(await this.canDomainBeProcessedAlready(new URL(source.url).hostname))
      ) {
        return;
      }
      const parsedFeed = await this.parseUrl(source.url);
      if (!parsedFeed) {
        llog("fail source");
        await this.sourcesRepository.failSource(source.id);
        return;
      }

      const articlePayloads = parsedFeed.items.map((item) => {
        const guid = this.generateGuid(item, parsedFeed, source.url);

        return {
          guid,
          sourceId: source.id,
          title: item.title ?? parsedFeed.title ?? parsedFeed.url ?? source.url,
          url: item.url ?? "",
          author:
            item.authors[0]?.name ??
            parsedFeed.title ??
            parsedFeed.url ??
            source.url,
          publishedAt: new Date(item.published || Date.now()),
          updatedAt: new Date(item.updated || item.published || Date.now()),
          content: fixupLinks(
            item.content ?? item.description ?? "",
            item.url ?? "",
          ),
        };
      });

      await this.articlesRepository.batchUpsertArticles(articlePayloads);

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (
        (source.lastSuccess !== null && source.lastSuccess < oneHourAgo) ||
        source.favicon === null
      ) {
        const urls = [
          `https://icons.duckduckgo.com/ip3/${source.homeUrl}.ico`,
          `https://unavatar.io/${source.homeUrl}`,
          `https://favicon.im/${source.homeUrl}`,
          `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${source.homeUrl}&size=64`,
        ];

        for (const url of urls) {
          try {
            const response = await container.cradle.axiosInstance.get(url, {
              responseType: "arraybuffer",
            });
            if (response.status !== 200) {
              continue;
            }
            await this.sourcesRepository.updateFavicon(
              source.id,
              response.data,
            );
          } catch {
            // nop
          }
        }
      }
      await this.sourcesRepository.successSource(source.id);
    } catch (e: unknown) {
      if (e instanceof Error) {
        err("parseSource", e.message);
      } else {
        err("parseSource", e);
      }
      llog("fail source");
      await this.sourcesRepository.failSource(source.id);
      err(source.url + " failed");
      return;
    }
  }

  private generateGuid(item: FeedItem, parsedFeed: Feed, sourceUrl: string) {
    if (item.id) {
      return item.id;
    }

    if (item.url && item.title) {
      return `${item.url}_${item.title}`;
    }

    const hashInput = [
      item.content,
      item.description,
      item.title,
      parsedFeed.title,
      parsedFeed.url,
      sourceUrl,
    ]
      .filter(Boolean)
      .join("_");

    return crypto.createHash("md5").update(hashInput).digest("hex");
  }

  private async canDomainBeProcessedAlready(domain: string): Promise<boolean> {
    const now = Date.now();
    const lastFetchKey = `lastFetchTimestamp:${domain}`;

    const lastFetchTimestamp = parseInt(
      (await this.redis.get(lastFetchKey)) || "0",
      10,
    );

    const defaultDelay = 10_000;
    const delaySetting = this.domainDelaySettings[domain] || defaultDelay;
    const remainingDelay = Math.max(
      0,
      delaySetting - (now - lastFetchTimestamp),
    );
    if (remainingDelay > 0) {
      return false;
    }
    await this.redis.set(lastFetchKey, now.toString());
    return true;
  }

  private async parseGenericFeed(url: string) {
    const response = await this.axiosInstance.get(url);

    if (response.status !== 200) {
      err(`failed to load data for ${url}`);
      return;
    }
    return parseFeed(response.data);
  }
}

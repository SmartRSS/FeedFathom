import { type ArticlesRepository } from "$lib/db/article-repository";
import { type SourcesRepository } from "$lib/db/source-repository";
import container from "../container";
import { logError as error } from "../util/log";
import { rewriteLinks } from "./rewrite-links";
import { parseFeed } from "@rowanmanning/feed-parser";
import { type Feed } from "@rowanmanning/feed-parser/lib/feed/base";
import { type FeedItem } from "@rowanmanning/feed-parser/lib/feed/item/base";
import { AxiosError } from "axios";
import { type AxiosCacheInstance } from "axios-cache-interceptor";
import type Redis from "ioredis";
import * as dns from "node:dns";

// const parserStrategies: Record<string, (url: string) => Promise<Feed | void>> =
//   {};

export class FeedParser {
  private readonly defaultDelay = 10_000;

  private domainDelaySettings: Record<string, number> = {
    "feeds.feedburner.com": 5_000,
    "openrss.org": 2_500,
    "youtube.com": 2_500,
  };

  constructor(
    private readonly articlesRepository: ArticlesRepository,
    private readonly axiosInstance: AxiosCacheInstance,
    private readonly redis: Redis,
    private readonly sourcesRepository: SourcesRepository,
  ) {}

  public async parseSource(source: {
    id: number;
    skipCache?: boolean;
    url: string;
  }) {
    try {
      if (
        !(await this.canDomainBeProcessedAlready(new URL(source.url).hostname))
      ) {
        return;
      }

      const { cached, feed: parsedFeed } = await this.parseUrl(source.url);

      if (cached && !source.skipCache) {
        await this.sourcesRepository.successSource(source.id, true);
        return;
      }

      const articlePayloads = parsedFeed.items.map((item) => {
        const guid = this.generateGuid(item, parsedFeed, source.url);
        return {
          author:
            item.authors[0]?.name ??
            parsedFeed.title ??
            parsedFeed.url ??
            source.url,
          content: rewriteLinks(
            item.content ?? item.description ?? "",
            item.url ?? "",
          ),
          guid,
          publishedAt: new Date(item.published ?? Date.now()),
          sourceId: source.id,
          title: item.title ?? parsedFeed.title ?? parsedFeed.url ?? source.url,
          updatedAt: new Date(item.updated ?? item.published ?? Date.now()),
          url: item.url ?? "",
        };
      });

      await this.articlesRepository.batchUpsertArticles(articlePayloads);
      articlePayloads.length = 0;

      await this.sourcesRepository.successSource(source.id);
    } catch (error_: unknown) {
      if (error_ instanceof Error) {
        error("parseSource", error_.message);
      } else {
        error("parseSource", error_);
      }

      let message = "";
      if (error_ instanceof AxiosError) {
        message +=
          error_.cause instanceof Object
            ? JSON.stringify(error_.cause)
            : error_.cause + "\n";
        message += error_.code + "\n";
        message += error_.message + "\n";
        message += error_.response?.status + "\n";
        message += error_.response?.data;
      } else {
        message = error_ instanceof Error ? error_.message : String(error_);
      }

      await this.sourcesRepository.failSource(source.id, message);
      error(source.url + " failed");
    }
  }

  public async parseUrl(url: string) {
    const urlObject = new URL(url);
    const lookupResult = await dns.promises.lookup(urlObject.hostname);
    if (!lookupResult.address) {
      throw new Error(`Failed to resolve ${urlObject.hostname}`);
    }

    // const chosenParser =
    //   parserStrategies[urlObject.origin] ?? this.parseGenericFeed;
    // return await chosenParser.bind(this)(url);
    return await this.parseGenericFeed(url);
  }

  public async preview(sourceUrl: string) {
    try {
      const { feed: parsedFeed } = await this.parseUrl(sourceUrl);
      return {
        description: parsedFeed.description,
        feedUrl: sourceUrl,
        link: parsedFeed.url,
        title: parsedFeed.title,
      };
    } catch {
      return {};
    }
  }

  public async refreshFavicon(source: { homeUrl: string; id: number }) {
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

        await this.sourcesRepository.updateFavicon(source.id, response.data);
        // Exit loop after successful update
        break;
      } catch {
        // nop
      }
    }
  }

  private async canDomainBeProcessedAlready(domain: string): Promise<boolean> {
    const now = Date.now();
    const lastFetchKey = `lastFetchTimestamp:${domain}`;

    const lastFetchTimestamp = Number.parseInt(
      (await this.redis.get(lastFetchKey)) ?? "0",
      10,
    );

    const delaySetting = this.domainDelaySettings[domain] ?? this.defaultDelay;
    if (now < lastFetchTimestamp + delaySetting) {
      return false;
    }

    await this.redis.set(lastFetchKey, now.toString());
    return true;
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
    return Bun.hash(hashInput).toString(36);
  }

  private async parseGenericFeed(url: string) {
    const response = await this.axiosInstance.get(url);

    if (response.status !== 200) {
      error(`failed to load data for ${url}`);
      throw new Error(
        `Failed to load data for ${url}, received status ${response.status}`,
      );
    }

    if (typeof response.data !== "string") {
      error(`failed to load data for ${url}`);
      throw new Error(
        `Failed to load data for ${url}, received status ${response.status}`,
      );
    }

    return { cached: response.cached, feed: parseFeed(response.data) };
  }
}

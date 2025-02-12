import * as dns from "node:dns";

import { parseFeed } from "@rowanmanning/feed-parser";
import type { Feed } from "@rowanmanning/feed-parser/lib/feed/base";
import { err, llog } from "../util/log";
import type { FeedItem } from "@rowanmanning/feed-parser/lib/feed/item/base";
import type { SourcesRepository } from "$lib/db/source-repository";
import type { ArticlesRepository } from "$lib/db/article-repository";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import container from "../container";
import type Redis from "ioredis";
import { rewriteLinks } from "./rewrite-links";
import { AxiosError } from "axios";

// const parserStrategies: Record<string, (url: string) => Promise<Feed | void>> =
//   {};

export class FeedParser {
  private readonly defaultDelay = 10_000;
  private domainDelaySettings: Record<string, number> = {
    "feeds.feedburner.com": 5000,
    "openrss.org": 2500,
    "youtube.com": 2500,
  };

  constructor(
    private readonly articlesRepository: ArticlesRepository,
    private readonly axiosInstance: AxiosCacheInstance,
    private readonly redis: Redis,
    private readonly sourcesRepository: SourcesRepository,
  ) {}

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
      return;
    }
  }

  public async parseUrl(url: string) {
    const urlObject = new URL(url);
    const lookupResult = await dns.promises.lookup(urlObject.hostname);
    if (!lookupResult.address) {
      throw new Error(`Failed to resolve ${urlObject.hostname}`);
    }

    // const chosenParser =
    //   parserStrategies[urlObject.origin] || this.parseGenericFeed;
    // return await chosenParser.bind(this)(url);
    return await this.parseGenericFeed(url);
  }

  public async parseSource(
    source: { id: number; url: string },
    skipCache: boolean = false,
  ) {
    try {
      if (
        !(await this.canDomainBeProcessedAlready(new URL(source.url).hostname))
      ) {
        return;
      }
      const { feed: parsedFeed, cached: cached } = await this.parseUrl(
        source.url,
      );
      if (cached && !skipCache) {
        llog(`${source.url} was cached`);
        await this.sourcesRepository.successSource(source.id);
        return;
      }
      llog(`${source.url} was not cached`);

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
          guid: guid,
          publishedAt: new Date(item.published || Date.now()),
          sourceId: source.id,
          title: item.title ?? parsedFeed.title ?? parsedFeed.url ?? source.url,
          updatedAt: new Date(item.updated || item.published || Date.now()),
          url: item.url ?? "",
        };
      });

      await this.articlesRepository.batchUpsertArticles(articlePayloads);
      articlePayloads.length = 0;

      await this.sourcesRepository.successSource(source.id);
    } catch (e: unknown) {
      if (e instanceof Error) {
        err("parseSource", e.message);
      } else {
        err("parseSource", e);
      }
      llog("fail source");
      let message = "";
      if (e instanceof AxiosError) {
        message += e.cause + "\n";
        message += e.code + "\n";
        message += e.message + "\n";
        message += e.response?.status + "\n";
        message += e.response?.data;
      } else {
        message = e instanceof Error ? e.message : String(e);
      }
      await this.sourcesRepository.failSource(source.id, message);
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
    return Bun.hash(hashInput).toString(36);
  }

  private async canDomainBeProcessedAlready(domain: string): Promise<boolean> {
    const now = Date.now();
    const lastFetchKey = `lastFetchTimestamp:${domain}`;

    const lastFetchTimestamp = parseInt(
      (await this.redis.get(lastFetchKey)) || "0",
      10,
    );

    const delaySetting = this.domainDelaySettings[domain] || this.defaultDelay;
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
      throw new Error(
        `Failed to load data for ${url}, received status ${response.status}`,
      );
    }
    if (typeof response.data !== "string") {
      err(`failed to load data for ${url}`);
      throw new Error(
        `Failed to load data for ${url}, received status ${response.status}`,
      );
    }
    return { feed: parseFeed(response.data), cached: response.cached };
  }

  public async refreshFavicon(source: { id: number; homeUrl: string }) {
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
        break; // Exit loop after successful update
      } catch {
        // nop
      }
    }
  }
}

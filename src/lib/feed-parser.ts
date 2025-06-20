import { lookup } from "node:dns/promises";
import { parseFeed } from "@rowanmanning/feed-parser";
import { AxiosError } from "axios";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import type { RedisClient } from "bun";
import container from "../container.ts";
import { logError as error } from "../util/log.ts";
import type { ArticlesDataService } from "./db/data-services/article-data-service";
import type { SourcesDataService } from "./db/data-services/source-data-service";
import { mapFeedItemToArticle, mapFeedToPreview } from "./feed-mapper.ts";
import { rewriteLinks } from "./rewrite-links.ts";

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
    private readonly articlesDataService: ArticlesDataService,
    private readonly axiosInstance: AxiosCacheInstance,
    private readonly redis: RedisClient,
    private readonly sourcesDataService: SourcesDataService,
  ) {}

  private formatErrorMessage(error_: unknown): string {
    if (error_ instanceof AxiosError) {
      return [
        error_.cause instanceof Object
          ? JSON.stringify(error_.cause)
          : "unknown cause",
        error_.code ?? "no code",
        error_.message,
        String(error_.response?.status ?? "no status"),
        typeof error_.response?.data === "string"
          ? error_.response.data
          : JSON.stringify(error_.response?.data ?? "no data"),
      ].join("\n");
    }
    return error_ instanceof Error ? error_.message : String(error_);
  }

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
        await this.sourcesDataService.successSource(source.id);
        return;
      }

      const articlePayloads = parsedFeed.items.map((item) => {
        return mapFeedItemToArticle(
          item,
          parsedFeed,
          { id: source.id, url: source.url },
          rewriteLinks,
        );
      });

      const articlesToUpsert = articlePayloads.map((payload) => ({
        guid: payload.guid,
        sourceId: payload.sourceId,
        title: payload.title,
        url: payload.url,
        author: payload.author,
        publishedAt: payload.publishedAt ?? new Date(),
        content: payload.content ?? "",
        updatedAt: new Date(), // Assume updatedAt is always the current date
      }));
      await this.articlesDataService.batchUpsertArticles(articlesToUpsert);
      articlePayloads.length = 0;

      await this.sourcesDataService.successSource(source.id);
    } catch (error_: unknown) {
      if (error_ instanceof Error) {
        error("parseSource", error_.message);
      } else {
        error("parseSource", error_);
      }

      const message = this.formatErrorMessage(error_);
      await this.sourcesDataService.failSource(source.id, message);
      error(`${source.url} failed`);
    }
  }

  public async parseUrl(url: string) {
    const urlObject = new URL(url);
    const lookupResult = await lookup(urlObject.hostname);
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
      return mapFeedToPreview(parsedFeed, sourceUrl);
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

        if (response.status !== 200 || !response.data) {
          continue;
        }

        let faviconPayload: string;

        if (response.data instanceof ArrayBuffer) {
          const buffer = Buffer.from(response.data);
          // Ignore small responses, likely errors or blank images
          if (buffer.length < 20) {
            continue;
          }
          const contentType = response.headers["content-type"] ?? "image/png";
          faviconPayload = `data:${contentType};base64,${buffer.toString(
            "base64",
          )}`;
        } else if (typeof response.data === "string") {
          // If it's a string, it must be a data URI, otherwise we don't know how to handle it.
          if (response.data.startsWith("data:image")) {
            faviconPayload = response.data;
          } else {
            continue;
          }
        } else {
          // Unsupported type
          continue;
        }

        await this.sourcesDataService.updateFavicon(source.id, faviconPayload);
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

  private async parseGenericFeed(url: string) {
    const response = await this.axiosInstance.get(url);

    if (response.status !== 200) {
      error(`failed to load data for ${url}`);
      throw new Error(
        `Failed to load data for ${url}, received status ${response.status.toString()}`,
      );
    }

    if (typeof response.data !== "string") {
      error(`failed to load data for ${url}`);
      throw new Error(
        `Failed to load data for ${url}, received status ${response.status.toString()}`,
      );
    }

    return { cached: response.cached, feed: parseFeed(response.data) };
  }
}

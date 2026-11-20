import { type Static, Type } from "typebox";
import { webUrlPolicy } from "#shared/validation/typebox-policy.ts";
import { type HttpClient } from "#platform/http/http-client.ts";
import {
  HttpDeferredError,
  HttpPacedError,
} from "#platform/http/http-deferred-error.ts";
import { defaultIntervals } from "#platform/http/http-rate-limiter.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import {
  imageDimensions,
  isBetterFavicon,
  targetFaviconSize,
} from "#features/feeds/favicon-selection.ts";
import { normalizeFavicon } from "#features/feeds/favicon-normalization.ts";
import {
  finishedJobRetention,
  JobDeferral,
  JobName,
} from "#features/feeds/queued-job.ts";

export const faviconGatherIntervalMs = 24 * 60 * 60_000;
export const faviconGatherWindowMs = faviconGatherIntervalMs + 60 * 60_000;

export const faviconDeferralHorizonMs = 2 * 60 * 60_000;

export const faviconRefreshBackstopMs =
  faviconGatherIntervalMs - 4 * 60 * 60_000;

export const refreshFaviconJobData = Type.Object({
  deferredSince: Type.Optional(Type.Integer({ minimum: 0 })),
  firstRunAt: Type.Optional(Type.Integer({ minimum: 0 })),
  hasFavicon: Type.Optional(Type.Boolean()),
  homeUrl: Type.Intersect([Type.String({ minLength: 1 }), webUrlPolicy]),
  id: Type.Integer({ minimum: 1 }),
});
type RefreshFaviconJob = Static<typeof refreshFaviconJobData>;

export type FaviconRefreshQueue = {
  addBulk(
    jobs: {
      data: RefreshFaviconJob;
      name: JobName;
      opts: typeof finishedJobRetention & { jobId: string; priority: number };
    }[],
  ): Promise<unknown>;
};

const slotPrefix = "favicon-refresh-slot:";
const slotGapMs = defaultIntervals.background + 2_000;

const reserveSlotScript = `
local gap = tonumber(ARGV[2])
local slot = tonumber(ARGV[1])
for _, key in ipairs(KEYS) do
  slot = math.max(slot, (tonumber(redis.call('GET', key)) or 0) + gap)
end
for _, key in ipairs(KEYS) do
  redis.call('SET', key, string.format('%d', slot), 'PXAT', string.format('%d', slot + gap))
end
return slot`;

export class FaviconRefresher {
  constructor(
    private readonly httpClient: HttpClient,
    private readonly sourcesDataService: Pick<
      SourcesDataService,
      "updateFavicon"
    >,
    private readonly redis: {
      send(command: "EVAL", args: string[]): Promise<unknown>;
    },
    private readonly queue: FaviconRefreshQueue,
  ) {}

  public async enqueueRefreshes(sources: readonly RefreshFaviconJob[]) {
    await this.queue.addBulk(
      sources.map((source) => ({
        data: source,
        name: JobName.RefreshFavicon,
        opts: {
          ...finishedJobRetention,
          jobId: `${JobName.RefreshFavicon}-${source.id}`,
          priority: 10,
        },
      })),
    );
  }

  private async bestFavicon(
    urls: string[],
    isMiss: (deferral: HttpDeferredError) => boolean,
  ) {
    const deferrals: Array<{ host: string; retryAt: number }> = [];
    const responses = await Promise.all(
      urls.map(async (url) => {
        try {
          return await this.httpClient.get(url, { priority: "background" });
        } catch (error: unknown) {
          if (error instanceof HttpDeferredError && !isMiss(error)) {
            deferrals.push({
              host: new URL(url).hostname,
              retryAt: error.retryAt,
            });
          }
          return undefined;
        }
      }),
    );

    let best: { buffer: Buffer; contentType: string; size: number } | undefined;
    for (const response of responses) {
      if (response?.status !== 200) continue;

      const buffer = Buffer.from(response.data);
      if (buffer.length < 20) continue;

      const dimensions = imageDimensions(buffer);
      if (!dimensions) continue;

      const size = Math.max(dimensions.width, dimensions.height);
      if (!best || isBetterFavicon(size, best.size, targetFaviconSize)) {
        best = {
          buffer,
          contentType: response.headers.get("content-type") ?? "image/png",
          size,
        };
      }
    }

    return {
      best,
      deferrals: best?.size === targetFaviconSize ? [] : deferrals,
    };
  }

  public async refreshFavicon(job: RefreshFaviconJob) {
    const source = { ...job, firstRunAt: job.firstRunAt ?? Date.now() };
    const hostname = URL.parse(source.homeUrl)?.hostname;
    if (hostname === undefined) return;
    const isMiss = (deferral: HttpDeferredError) => {
      const now = Date.now();
      if (now > source.firstRunAt + faviconRefreshBackstopMs) return true;
      if (deferral instanceof HttpPacedError) return false;
      source.deferredSince ??= now;
      return deferral.retryAt > source.deferredSince + faviconDeferralHorizonMs;
    };
    let found = await this.bestFavicon(
      [
        `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(source.homeUrl)}&size=${targetFaviconSize}`,
        `https://favicon.im/${hostname}?throw-error-on-404=true`,
        `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
      ],
      isMiss,
    );
    if (!found.best && found.deferrals.length === 0) {
      found = await this.bestFavicon(
        [`https://unavatar.io/domain/${hostname}?size=${targetFaviconSize}`],
        isMiss,
      );
    }
    if (
      found.best &&
      (found.deferrals.length === 0 || source.hasFavicon === false)
    ) {
      const favicon = await normalizeFavicon(
        found.best.buffer,
        found.best.contentType,
      );
      await this.sourcesDataService.updateFavicon(
        source.id,
        favicon.buffer,
        favicon.contentType,
      );
      source.hasFavicon = true;
    }
    if (found.deferrals.length > 0) {
      throw new JobDeferral(await this.reserveSlot(found.deferrals), source);
    }
  }

  private async reserveSlot(
    deferrals: Array<{ host: string; retryAt: number }>,
  ) {
    const keys = [...new Set(deferrals.map(({ host }) => slotPrefix + host))];
    const retryAt = Math.max(...deferrals.map((deferral) => deferral.retryAt));
    return Number(
      await this.redis.send("EVAL", [
        reserveSlotScript,
        keys.length.toString(),
        ...keys,
        Math.ceil(retryAt).toString(),
        slotGapMs.toString(),
      ]),
    );
  }
}

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

// How often every live source's favicon is refreshed. The gather takes each
// source fetched within the window: the previous run, plus an hour of slack
// for a daily poll landing late.
export const faviconGatherIntervalMs = 24 * 60 * 60_000;
export const faviconGatherWindowMs = faviconGatherIntervalMs + 60 * 60_000;

// A refresh that a provider blocks waits at most this long past the first
// block. That rides out the hour-long Retry-After that providers commonly
// send, and a provider blocking past it counts as a miss, so one that never
// stops answering 429 cannot hold back every icon. The limiter's own pacing
// does not start or count against it: a job that waited hours in the queue
// still gets the full horizon for a block it meets later.
export const faviconDeferralHorizonMs = 2 * 60 * 60_000;

// Past this long after a job's first run, every deferral is a miss, pacing
// included, so each job completes, and frees its jobId, before the next
// gather.
export const faviconRefreshBackstopMs =
  faviconGatherIntervalMs - 4 * 60 * 60_000;

// `firstRunAt` is when this refresh first ran and `deferredSince` when a
// provider first blocked it, both carried across deferrals in the job data.
// Only `hasFavicon: false` lets a deferred refresh store an icon: job data
// from before the field existed may belong to a source that has one.
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

// Deferred refreshes queue up behind one another, one slot per background
// interval plus slack for start jitter and the round trips of a job's own
// requests, so they wake one at a time instead of all at the same retryAt.
// There is one queue per provider host, as the limiter is per host: a job
// takes a slot in the queue of every host that deferred it, so a long block
// on one provider does not hold back jobs that only wait on the others.
const slotPrefix = "favicon-refresh-slot:";
const slotGapMs = defaultIntervals.background + 2_000;

// Returns the latest of ARGV[1] and one gap past the last slot of each key,
// and records it as the last slot of every key, atomically across worker
// instances. A key lives until its slot is a gap behind; after that, any
// retryAt wins anyway.
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

/**
 * Fetches a site's favicon from the free providers and stores the best result.
 *
 * Separate from feed parsing: it shares a source and an HTTP client with the
 * parser and nothing else, and it answers a different question -- what does
 * this site look like, not what did it publish.
 */
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

  // No delay: most refreshes are answered from the HTTP cache. One that a
  // provider defers queues for its own slot (#1087).
  public async enqueueRefreshes(sources: readonly RefreshFaviconJob[]) {
    await this.queue.addBulk(
      sources.map((source) => ({
        data: source,
        name: JobName.RefreshFavicon,
        opts: {
          ...finishedJobRetention,
          // A refresh still delayed by a provider's Retry-After keeps this
          // id, so the next gather's add does not jump its backoff.
          jobId: `${JobName.RefreshFavicon}-${source.id}`,
          // BullMQ runs unprioritized jobs (ParseSource, Cleanup,
          // GatherJobs) first, so a large favicon run can't crowd out feed
          // parsing.
          priority: 10,
        },
      })),
    );
  }

  // The best answer, and the providers whose deferral is not a miss: those
  // may still hold a better icon, so the caller defers rather than settle. An
  // answer at exactly the target size cannot be beaten (isBetterFavicon), so
  // it needs no wait.
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

  /**
   * Throws a JobDeferral, carrying the job data its retry needs, when a
   * provider that may still hold a better icon asks to be retried later.
   */
  public async refreshFavicon(job: RefreshFaviconJob) {
    const source = { ...job, firstRunAt: job.firstRunAt ?? Date.now() };
    // Query the free providers concurrently and keep the smallest valid
    // image that still meets targetFaviconSize (falling back to the
    // biggest available if none do) -- an earlier one can succeed with a
    // smaller icon while a later one has a bigger one. unavatar.io is
    // capped at 25 requests/day on the free tier, so it's only used as a
    // last resort when nothing else has an icon.
    const hostname = URL.parse(source.homeUrl)?.hostname;
    if (hostname === undefined) return;
    const isMiss = (deferral: HttpDeferredError) => {
      const now = Date.now();
      if (now > source.firstRunAt + faviconRefreshBackstopMs) return true;
      // The limiter's own pacing always clears, so only an origin's block can
      // go past the horizon, however short its Retry-After.
      if (deferral instanceof HttpPacedError) return false;
      source.deferredSince ??= now;
      return deferral.retryAt > source.deferredSince + faviconDeferralHorizonMs;
    };
    // homeUrl is encoded: a raw `?` or `&` in it would end up in gstatic's
    // own query string. favicon.im takes a bare domain in its path, and
    // without throw-error-on-404 it answers an unknown domain with a generic
    // SVG that would outrank every real icon below 64 px.
    let found = await this.bestFavicon(
      [
        `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(source.homeUrl)}&size=${targetFaviconSize}`,
        `https://favicon.im/${hostname}?throw-error-on-404=true`,
        `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
      ],
      isMiss,
    );
    // A primary deferred inside the horizon is not a miss, so unavatar is
    // only asked once every primary provider has really missed.
    if (!found.best && found.deferrals.length === 0) {
      found = await this.bestFavicon(
        [`https://unavatar.io/domain/${hostname}?size=${targetFaviconSize}`],
        isMiss,
      );
    }
    // A deferred provider never replaces a stored icon with a smaller one,
    // but a source with no icon yet shows the best one found so far while it
    // waits.
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

import type { AppConfig } from "#platform/config.ts";
import type { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import type { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { DelayedError, type Job, type JobsOptions } from "bullmq";
import { webUrlPolicy } from "#shared/validation/typebox-policy.ts";
import { JobName } from "#shared/types/job-name-enum.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import {
  type HubPoster,
  requestHubSubscription,
} from "#features/feeds/websub.ts";

const emptyJobData = Type.Object({}, { additionalProperties: false });
const sourceUrl = Type.Intersect([Type.String({ minLength: 1 }), webUrlPolicy]);
const mainWorkerJobData = Type.Union([
  Type.Object({
    data: emptyJobData,
    name: Type.Literal(JobName.Cleanup),
  }),
  Type.Object({
    data: emptyJobData,
    name: Type.Literal(JobName.GatherFaviconJobs),
  }),
  Type.Object({
    data: emptyJobData,
    name: Type.Literal(JobName.GatherJobs),
  }),
  Type.Object({
    data: Type.Object({
      id: Type.Integer({ minimum: 1 }),
      skipCache: Type.Optional(Type.Boolean()),
      trigger: Type.Optional(
        Type.Union([Type.Literal("manual"), Type.Literal("websub-push")]),
      ),
      url: Type.Optional(sourceUrl),
    }),
    name: Type.Literal(JobName.ParseSource),
  }),
  Type.Object({
    data: Type.Object({
      firstRunAt: Type.Optional(Type.Integer({ minimum: 0 })),
      homeUrl: sourceUrl,
      id: Type.Integer({ minimum: 1 }),
    }),
    name: Type.Literal(JobName.RefreshFavicon),
  }),
  Type.Object({
    data: emptyJobData,
    name: Type.Literal(JobName.WebSubRenewal),
  }),
]);
const mainWorkerJobCheck = Schema.Compile(mainWorkerJobData);

export type MainWorkerJob = {
  data: unknown;
  moveToDelayed(timestamp: number, token?: string): Promise<unknown>;
  name: string;
  token?: string;
  updateData(data: unknown): Promise<unknown>;
};

type MainWorkerQueue = {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
  addBulk(
    jobs: { data: unknown; name: string; opts?: JobsOptions }[],
  ): Promise<unknown>;
  upsertJobScheduler(
    name: string,
    repeat: { every: number },
    template: { opts: JobsOptions },
  ): Promise<unknown>;
};

type JobWorker = {
  close(): Promise<void>;
  on(
    event: "failed",
    listener: (job: Job | undefined, error: Error) => void,
  ): unknown;
  waitUntilReady(): Promise<unknown>;
};

export type MainWorkerServices = {
  bullmqQueue: MainWorkerQueue;
  // The retention prune over the worker's own database connection.
  cleanupOrphanedData(
    userDormantAfterDays: number,
    articleStaleAfterDays: number,
    userExpiryDays: number,
  ): Promise<number[]>;
  config: AppConfig;
  // The BullMQ worker on the "tasks" queue, consuming with this processor.
  createWorker(
    processor: (job: MainWorkerJob) => Promise<void>,
    options: { concurrency: number; lockDuration: number },
  ): JobWorker;
  faviconRefresher: FaviconRefresher;
  feedParser: FeedParser;
  hubPoster: HubPoster;
  sourceEnqueuer: SourceEnqueuer;
  sourcesDataService: SourcesDataService;
  userSourcesDataService: UserSourcesDataService;
  websubStateService: WebSubStateService;
};

export class MainWorker {
  private worker: JobWorker | undefined;

  constructor(private readonly services: MainWorkerServices) {}

  async initialize() {
    await this.setupScheduledTasks();
    await this.services.bullmqQueue.addBulk(await this.gatherParseSourceJobs());
    // Resolves once both of the worker's Redis connections are up, the
    // blocking one included, so the worker is fetching jobs from here on.
    await this.startWorker().waitUntilReady();
  }

  async cleanup() {
    await this.worker?.close();
  }

  private async gatherParseSourceJobs() {
    const { sourcesDataService } = this.services;
    const sources = await sourcesDataService.getSourcesToProcess();

    return sources.map((source) => ({
      data: source,
      name: JobName.ParseSource,
      opts: {
        jobId: `${JobName.ParseSource}-${source.id}`,
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    }));
  }

  private readonly processJob = async (job: MainWorkerJob) => {
    // Set once a follow-up parse owns intent taken off the pending marker. A
    // deferral from there on retries from job.data, so the intent has to be
    // written into it or the retry would parse the original request (#847).
    // A favicon refresh writes when it first ran, which its horizon counts
    // from.
    let retryData: unknown;
    const {
      bullmqQueue,
      config: appConfig,
      faviconRefresher,
      feedParser,
      hubPoster,
      sourceEnqueuer,
      sourcesDataService,
      userSourcesDataService,
      websubStateService,
    } = this.services;
    let delayed = false;
    try {
      const input = { data: job.data, name: job.name };
      if (!mainWorkerJobCheck.Check(input)) {
        throw new Error(`Invalid job payload for type: ${job.name}`);
      }

      switch (input.name) {
        case JobName.Cleanup: {
          const prunedSourceIds = await this.services.cleanupOrphanedData(
            appConfig.USER_DORMANT_AFTER_DAYS,
            appConfig.ARTICLE_STALE_AFTER_DAYS,
            appConfig.USER_EXPIRY_DAYS,
          );
          // The prune bypasses the data services, so the unread badge of a
          // source it emptied would keep counting deleted articles until an
          // unrelated event recounted it (#812).
          await userSourcesDataService.recomputeUnreadCounts(prunedSourceIds);
          break;
        }

        case JobName.GatherFaviconJobs: {
          const dueSources =
            await sourcesDataService.getSourcesDueFaviconRefresh();

          await Promise.all(
            dueSources.map((source) => {
              const jobId = `${JobName.RefreshFavicon}-${source.id}`;
              // No delay: most refreshes are answered from the HTTP cache.
              // One that a provider defers queues for its own slot (#1087).
              return bullmqQueue.add(JobName.RefreshFavicon, source, {
                // A refresh still delayed by a provider's Retry-After keeps
                // this id, so the next day's add does not jump its backoff.
                jobId,
                // BullMQ runs unprioritized jobs (ParseSource, Cleanup,
                // GatherJobs) first, so a large favicon run can't crowd out
                // feed parsing.
                priority: 10,
                removeOnComplete: { count: 0 },
                removeOnFail: { count: 0 },
              });
            }),
          );

          break;
        }

        case JobName.GatherJobs: {
          await bullmqQueue.addBulk(await this.gatherParseSourceJobs());
          break;
        }

        case JobName.ParseSource: {
          const source = await sourcesDataService.findSourceById(input.data.id);
          if (!source) {
            throw new Error(`Source with ID ${input.data.id} not found`);
          }
          const parse = async (
            skipCache: boolean | undefined,
            trigger: "manual" | "poll" | "websub-push",
          ) =>
            await feedParser.parseSource({
              ...source,
              ...(skipCache === undefined ? {} : { skipCache }),
              trigger,
            });
          await parse(input.data.skipCache, input.data.trigger ?? "poll");
          // Requests that landed mid-run were recorded on a marker rather
          // than queued, because BullMQ would have deduped their add against
          // this job (#813). Handing them back to the enqueuer would hit that
          // same dedupe -- the id stays active until this processor returns --
          // so the run folds them in itself and parses once more, right here,
          // the way the newest request asked. Anything arriving during that
          // pass stays on the marker: a deferral, the next poll or the next
          // request all reach it.
          const pending = await sourceEnqueuer.takePendingRefresh(source.id);
          if (pending) {
            retryData = {
              ...input.data,
              skipCache: pending.skipCache,
              trigger: "manual",
            };
            await parse(pending.skipCache, "manual");
          }
          break;
        }

        case JobName.RefreshFavicon: {
          const firstRunAt = input.data.firstRunAt ?? Date.now();
          retryData = { ...input.data, firstRunAt };
          await faviconRefresher.refreshFavicon({ ...input.data, firstRunAt });
          break;
        }

        case JobName.WebSubRenewal: {
          const domain = appConfig.FEED_FATHOM_DOMAIN;
          if (!domain) break;
          const subscriptions =
            await websubStateService.getWebSubSubscriptionsNeedingRenewal();
          await Promise.all(
            subscriptions.map(async (subscription) => {
              // All four columns are nullable, but every row here is already
              // websubStatus: "verified", which only happens once
              // recordWebSubDiscovery wrote them together. Checked rather than
              // asserted -- the type system can't promise a DB invariant.
              if (
                !subscription.hubUrl ||
                !subscription.topicUrl ||
                !subscription.secret ||
                !subscription.callbackToken
              )
                return;
              const result = await requestHubSubscription({
                callbackToken: subscription.callbackToken,
                domain,
                hubPoster,
                hubUrl: subscription.hubUrl,
                secret: subscription.secret,
                topicUrl: subscription.topicUrl,
              });
              if (!result.ok) {
                console.error(
                  `WebSub renewal failed for source ${subscription.id}: ${result.error}`,
                );
                await websubStateService.markWebSubFailed(subscription.id);
              }
            }),
          );
          break;
        }
      }
    } catch (error: unknown) {
      // Anything thrown, including by the deferral itself (a Redis error, a
      // poisoned retryAt getter), is logged and acknowledged, so BullMQ
      // never holds the job in its failure state. The outcomes something
      // reads stay in Postgres where their owner writes them: parseSource
      // records a source's failure, and the WebSub renewal above its own.
      try {
        if (!(error instanceof HttpDeferredError)) throw error;
        if (retryData !== undefined) await job.updateData(retryData);
        await job.moveToDelayed(error.retryAt, job.token);
        delayed = true;
      } catch {
        try {
          console.error(`Error processing ${job.name} job:`, error);
        } catch {
          // Swallowed without logging: an adversarial thrown value (a
          // poisoned custom-inspect symbol) is what made the log call throw.
        }
      }
    }
    // The one value that leaves the processor: BullMQ reads it as "moved
    // to delayed", not as a failure.
    if (delayed) throw new DelayedError();
  };

  private async setupScheduledTasks() {
    const { bullmqQueue, config: appConfig } = this.services;
    const daily = 86_400_000;
    const schedule: Array<[JobName, number]> = [
      [JobName.Cleanup, appConfig.CLEANUP_INTERVAL * 1_000],
      [JobName.GatherJobs, appConfig.GATHER_JOBS_INTERVAL * 1_000],
      [JobName.GatherFaviconJobs, daily],
      [JobName.WebSubRenewal, daily],
    ];
    for (const [name, every] of schedule) {
      // Without the template every tick stays in the completed set forever:
      // a 20-second scheduler had piled up a million entries in Redis.
      // eslint-disable-next-line no-await-in-loop -- BullMQ scheduler registration is ordered.
      await bullmqQueue.upsertJobScheduler(
        name,
        { every },
        {
          opts: { removeOnComplete: { count: 0 }, removeOnFail: { count: 0 } },
        },
      );
    }
  }

  private startWorker() {
    const { config: appConfig } = this.services;
    const workerConcurrency = appConfig.WORKER_CONCURRENCY;
    console.log(`Setting up worker with concurrency: ${workerConcurrency}`);

    const worker = this.services.createWorker(this.processJob, {
      concurrency: workerConcurrency,
      lockDuration: appConfig.LOCK_DURATION * 1_000,
    });
    worker.on("failed", (job, error) => {
      console.error(`Worker job failed: ${job?.id ?? "unknown"}`, error);
    });
    this.worker = worker;

    console.log("Worker pool setup complete");
    return worker;
  }
}

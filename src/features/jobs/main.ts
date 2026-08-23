import { Type } from "typebox";
import Schema from "typebox/schema";
import { DelayedError } from "bullmq";
import { webUrlPolicy } from "#shared/validation/typebox-policy.ts";
import { JobName } from "#shared/types/job-name-enum.ts";
import type { AppConfig } from "#platform/config.ts";
import { isHttpDeferredError } from "#platform/http/http-deferred-error.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { requestHubSubscription } from "#features/feeds/websub.ts";
import type { JobFailuresDataService } from "#features/admin/job-failure-data-service.ts";

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

type QueueOptions = {
  jobId?: string;
  priority?: number;
  removeOnComplete?: { count: number };
  removeOnFail?: { count: number };
  repeat?: { every: number };
};

type QueueJob = {
  data: unknown;
  name: string;
  opts?: QueueOptions;
};

export type MainWorkerQueue = {
  add(name: string, data: unknown, options?: QueueOptions): Promise<unknown>;
  addBulk(jobs: QueueJob[]): Promise<unknown>;
};

export type MainWorkerJob = {
  data: unknown;
  moveToDelayed(timestamp: number, token?: string): Promise<unknown>;
  name: string;
  token?: string;
};

type WorkerControls = {
  close(): Promise<unknown>;
  onFailed(
    listener: (job: { id?: string } | undefined, error: unknown) => void,
  ): void;
};

export type MainWorkerFactory = (
  processor: (job: MainWorkerJob) => Promise<void>,
  options: { concurrency: number; lockDuration: number },
) => WorkerControls;

type MainWorkerConfig = Pick<
  AppConfig,
  | "CLEANUP_INTERVAL"
  | "FEED_FATHOM_DOMAIN"
  | "GATHER_JOBS_INTERVAL"
  | "LOCK_DURATION"
  | "WORKER_CONCURRENCY"
>;

type MainWorkerSources = Pick<
  SourcesDataService,
  | "findSourceById"
  | "getRecentlySuccessfulSources"
  | "getSourcesToProcess"
  | "getWebSubSubscriptionsNeedingRenewal"
  | "markWebSubFailed"
>;

export class MainWorker {
  private worker: WorkerControls | undefined;

  constructor(
    private readonly appConfig: MainWorkerConfig,
    private readonly bullmqQueue: MainWorkerQueue,
    private readonly feedParser: Pick<FeedParser, "parseSource">,
    private readonly faviconRefresher: Pick<FaviconRefresher, "refreshFavicon">,
    private readonly sourcesDataService: MainWorkerSources,
    private readonly cleanupOrphanedData: () => Promise<void>,
    private readonly jobFailuresDataService: Pick<
      JobFailuresDataService,
      "record"
    >,
    private readonly createWorker: MainWorkerFactory,
  ) {}

  async initialize() {
    await this.setupScheduledTasks();
    await this.bullmqQueue.addBulk(await this.gatherParseSourceJobs());
    this.startWorker();
  }

  async cleanup() {
    await this.worker?.close();
  }

  private async gatherParseSourceJobs() {
    const sources = await this.sourcesDataService.getSourcesToProcess();

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
    try {
      const input = { data: job.data, name: job.name };
      if (!mainWorkerJobCheck.Check(input)) {
        throw new Error(`Invalid job payload for type: ${job.name}`);
      }

      switch (input.name) {
        case JobName.Cleanup: {
          await this.cleanupOrphanedData();
          break;
        }

        case JobName.GatherFaviconJobs: {
          const successfulSources =
            await this.sourcesDataService.getRecentlySuccessfulSources();

          await Promise.all(
            successfulSources.map((source) => {
              const jobId = `${JobName.RefreshFavicon}-${source.id}`;
              return this.bullmqQueue.add(JobName.RefreshFavicon, source, {
                jobId,
                // Jobs with no explicit priority (ParseSource, Cleanup,
                // GatherJobs) are always processed before prioritized
                // jobs in BullMQ, so a large favicon-refresh run queued
                // here can never crowd out feed parsing.
                priority: 10,
                removeOnComplete: { count: 0 },
                removeOnFail: { count: 0 },
              });
            }),
          );

          break;
        }

        case JobName.GatherJobs: {
          await this.bullmqQueue.addBulk(await this.gatherParseSourceJobs());
          break;
        }

        case JobName.ParseSource: {
          const source = await this.sourcesDataService.findSourceById(
            input.data.id,
          );
          if (!source) {
            throw new Error(`Source with ID ${input.data.id} not found`);
          }
          await this.feedParser.parseSource({
            ...source,
            ...(input.data.skipCache === undefined
              ? {}
              : { skipCache: input.data.skipCache }),
            trigger: input.data.trigger ?? "poll",
          });
          break;
        }

        case JobName.RefreshFavicon: {
          await this.faviconRefresher.refreshFavicon(input.data);
          break;
        }

        case JobName.WebSubRenewal: {
          const domain = this.appConfig.FEED_FATHOM_DOMAIN;
          if (!domain) break;
          const subscriptions =
            await this.sourcesDataService.getWebSubSubscriptionsNeedingRenewal();
          await Promise.all(
            subscriptions.map(async (subscription) => {
              // hubUrl/topicUrl/secret/callbackToken are nullable columns
              // (most sources never subscribe at all), but every row this
              // query returns is already websubStatus: "verified", which
              // only happens after all four were written together in
              // recordWebSubDiscovery -- still checked rather than
              // asserted, since "the DB row matches the invariant" isn't
              // something the type system can promise.
              if (
                !subscription.hubUrl ||
                !subscription.topicUrl ||
                !subscription.secret ||
                !subscription.callbackToken
              )
                return;
              const result = await requestHubSubscription({
                callbackUrl: `https://${domain}/api/websub/callback/${subscription.callbackToken}`,
                hubUrl: subscription.hubUrl,
                mode: "subscribe",
                secret: subscription.secret,
                topicUrl: subscription.topicUrl,
              });
              if (!result.ok) {
                console.error(
                  `WebSub renewal failed for source ${subscription.id}: ${result.error}`,
                );
                await this.sourcesDataService.markWebSubFailed(subscription.id);
              }
            }),
          );
          break;
        }
      }
    } catch (error: unknown) {
      if (isHttpDeferredError(error)) {
        try {
          await job.moveToDelayed(error.retryAt, job.token);
          throw new DelayedError();
        } catch (moveError) {
          const isDelayed = (() => {
            try {
              return moveError instanceof DelayedError;
            } catch {
              return false;
            }
          })();
          if (isDelayed) {
            throw moveError;
          }
          // moveToDelayed itself failed (e.g. a genuine Redis/BullMQ
          // error, or a poisoned retryAt getter) -- fall through to the
          // guarded failure-recording path below instead of letting this
          // propagate and fail the job in BullMQ's own state.
        }
      }
      try {
        // Everything here -- logging the error, building its message, and
        // recording it -- must never itself become a job failure, or a
        // sufficiently adversarial thrown value (a poisoned `message`
        // getter, a poisoned custom-inspect symbol console.error relies
        // on, ...) would put the job into BullMQ's failure state instead
        // of always acknowledging and keeping outcomes in Postgres, which
        // is this codebase's established convention. Rather than guard
        // each statement individually (this has already needed three
        // rounds of narrowing), the whole block is one try/catch.
        console.error("Error processing job:", error);
        const message = error instanceof Error ? error.message : String(error);
        await this.jobFailuresDataService.record(job.name, message);
      } catch {
        // Deliberately swallowed with no further logging: logging the
        // original failure already failed once in this block, so trying
        // to log *that* failure risks the exact same unguarded-throw
        // problem all over again. There's nothing more we can safely do.
      }
    }
  };

  private async setupScheduledTasks() {
    await this.bullmqQueue.add(
      JobName.Cleanup,
      {},
      {
        jobId: JobName.Cleanup,
        repeat: { every: this.appConfig.CLEANUP_INTERVAL * 1_000 },
      },
    );

    await this.bullmqQueue.add(
      JobName.GatherJobs,
      {},
      {
        jobId: JobName.GatherJobs,
        repeat: { every: this.appConfig.GATHER_JOBS_INTERVAL * 1_000 },
      },
    );

    await this.bullmqQueue.add(
      JobName.GatherFaviconJobs,
      {},
      {
        jobId: JobName.GatherFaviconJobs,
        repeat: { every: 86_400_000 },
      },
    );

    await this.bullmqQueue.add(
      JobName.WebSubRenewal,
      {},
      {
        jobId: JobName.WebSubRenewal,
        repeat: { every: 86_400_000 },
      },
    );
  }

  private startWorker() {
    const workerConcurrency = this.appConfig.WORKER_CONCURRENCY;
    console.log(`Setting up worker with concurrency: ${workerConcurrency}`);

    this.worker = this.createWorker(this.processJob, {
      concurrency: workerConcurrency,
      lockDuration: this.appConfig.LOCK_DURATION * 1_000,
    });
    this.worker.onFailed((job, error) => {
      console.error(`Worker job failed: ${job?.id ?? "unknown"}`, error);
    });

    console.log("Worker pool setup complete");
  }
}

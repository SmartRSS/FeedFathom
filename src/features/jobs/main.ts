import type { AppConfig } from "#platform/config.ts";
import type { FaviconRefresher } from "#features/feeds/favicon-refresher.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { RetentionService } from "#features/feeds/retention.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { SourceEnqueuer } from "#features/feeds/source-enqueue.ts";
import type { WebSubSubscriber } from "#features/feeds/websub-subscriber.ts";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { DelayedError, type Job, type JobsOptions } from "bullmq";
import { JobName } from "#shared/types/job-name-enum.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import {
  faviconGatherIntervalMs,
  refreshFaviconJobData,
} from "#features/feeds/favicon-refresher.ts";
import {
  finishedJobRetention,
  JobDeferral,
} from "#features/feeds/queued-job.ts";
import { parseSourceJobData } from "#features/feeds/source-enqueue.ts";
import { webSubRenewalIntervalMs } from "#features/feeds/websub-subscriber.ts";

const emptyJobData = Type.Object({}, { additionalProperties: false });
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
    data: parseSourceJobData,
    name: Type.Literal(JobName.ParseSource),
  }),
  Type.Object({
    data: refreshFaviconJobData,
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
  config: AppConfig;
  createWorker(
    processor: (job: MainWorkerJob) => Promise<void>,
    options: { concurrency: number; lockDuration: number },
  ): JobWorker;
  faviconRefresher: Pick<
    FaviconRefresher,
    "enqueueRefreshes" | "refreshFavicon"
  >;
  feedParser: Pick<FeedParser, "parseSource">;
  retentionService: Pick<RetentionService, "prune">;
  sourceEnqueuer: Pick<SourceEnqueuer, "enqueueDueSources" | "runParse">;
  sourcesDataService: Pick<
    SourcesDataService,
    "findSourceById" | "getSourcesDueFaviconRefresh" | "getSourcesToProcess"
  >;
  webSubSubscriber: Pick<WebSubSubscriber, "renewDue">;
};

export class MainWorker {
  private worker: JobWorker | undefined;

  constructor(private readonly services: MainWorkerServices) {}

  async initialize() {
    await this.setupScheduledTasks();
    await this.enqueueDueSources();
    // Resolves once both of the worker's Redis connections are up, the
    // blocking one included, so the worker is fetching jobs from here on.
    await this.startWorker().waitUntilReady();
  }

  async cleanup() {
    await this.worker?.close();
  }

  private async enqueueDueSources() {
    const { sourceEnqueuer, sourcesDataService } = this.services;
    await sourceEnqueuer.enqueueDueSources(
      await sourcesDataService.getSourcesToProcess(),
    );
  }

  // Anything thrown, including by the deferral itself (a Redis error, a
  // poisoned retryAt getter), is logged and acknowledged, so BullMQ never
  // holds the job in its failure state. The outcomes something reads stay
  // in PostgreSQL where their owner writes them: parseSource records a
  // source's failure, and the WebSub subscriber a refused renewal.
  private readonly processJob = async (job: MainWorkerJob) => {
    try {
      await this.runJob(job);
    } catch (error: unknown) {
      // The one value that leaves the processor: BullMQ reads it as "moved
      // to delayed", not as a failure.
      if (await this.deferred(job, error)) throw new DelayedError();
    }
  };

  // True once the job waits for its retry. Anything else is logged.
  private async deferred(job: MainWorkerJob, error: unknown) {
    try {
      if (!(error instanceof HttpDeferredError)) throw error;
      if (error instanceof JobDeferral) await job.updateData(error.data);
      await job.moveToDelayed(error.retryAt, job.token);
      return true;
    } catch {
      try {
        console.error(`Error processing ${job.name} job:`, error);
      } catch {
        // Swallowed without logging: an adversarial thrown value (a
        // poisoned custom-inspect symbol) is what made the log call throw.
      }
      return false;
    }
  }

  private async runJob(job: MainWorkerJob) {
    const {
      faviconRefresher,
      feedParser,
      retentionService,
      sourceEnqueuer,
      sourcesDataService,
      webSubSubscriber,
    } = this.services;
    const input = { data: job.data, name: job.name };
    if (!mainWorkerJobCheck.Check(input)) {
      throw new Error(`Invalid job payload for type: ${job.name}`);
    }

    switch (input.name) {
      case JobName.Cleanup: {
        await retentionService.prune();
        break;
      }

      case JobName.GatherFaviconJobs: {
        await faviconRefresher.enqueueRefreshes(
          await sourcesDataService.getSourcesDueFaviconRefresh(),
        );
        break;
      }

      case JobName.GatherJobs: {
        await this.enqueueDueSources();
        break;
      }

      case JobName.ParseSource: {
        const source = await sourcesDataService.findSourceById(input.data.id);
        if (!source) {
          throw new Error(`Source with ID ${input.data.id} not found`);
        }
        await sourceEnqueuer.runParse(input.data, async (request) => {
          await feedParser.parseSource({
            ...source,
            ...(request.skipCache === undefined
              ? {}
              : { skipCache: request.skipCache }),
            trigger: request.trigger ?? "poll",
          });
        });
        break;
      }

      case JobName.RefreshFavicon: {
        await faviconRefresher.refreshFavicon(input.data);
        break;
      }

      case JobName.WebSubRenewal: {
        await webSubSubscriber.renewDue();
        break;
      }
    }
  }

  private async setupScheduledTasks() {
    const { bullmqQueue, config: appConfig } = this.services;
    const schedule: Array<[JobName, number]> = [
      [JobName.Cleanup, appConfig.CLEANUP_INTERVAL * 1_000],
      [JobName.GatherJobs, appConfig.GATHER_JOBS_INTERVAL * 1_000],
      [JobName.GatherFaviconJobs, faviconGatherIntervalMs],
      [JobName.WebSubRenewal, webSubRenewalIntervalMs],
    ];
    for (const [name, every] of schedule) {
      // Without the template every tick stays in the completed set forever:
      // a 20-second scheduler had piled up a million entries in Redis.
      // eslint-disable-next-line no-await-in-loop -- BullMQ scheduler registration is ordered.
      await bullmqQueue.upsertJobScheduler(
        name,
        { every },
        { opts: finishedJobRetention },
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

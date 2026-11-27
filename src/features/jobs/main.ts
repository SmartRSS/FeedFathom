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
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import type { WorkerJobHandlers } from "#platform/worker-jobs.ts";
import {
  answerWorkerRequest,
  type WorkerReply,
  type WorkerRequestHandlers,
} from "#platform/worker-requests.ts";
import {
  faviconGatherIntervalMs,
  refreshFaviconJobData,
} from "#features/feeds/favicon-refresher.ts";
import {
  finishedJobRetention,
  JobDeferral,
  JobName,
} from "#features/feeds/queued-job.ts";
import {
  discoverWebSubJobData,
  parseSourceJobData,
} from "#features/feeds/source-enqueue.ts";
import { webSubRenewalIntervalMs } from "#features/feeds/websub-subscriber.ts";

const emptyJobData = Type.Object({}, { additionalProperties: false });
const mainWorkerJobData = Type.Union([
  Type.Object({
    data: emptyJobData,
    name: Type.Literal(JobName.Cleanup),
  }),
  Type.Object({
    data: discoverWebSubJobData,
    name: Type.Literal(JobName.DiscoverWebSub),
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

export type WorkerRequestJob = {
  data: unknown;
  name: string;
  timestamp: number;
};

type JobWorker = {
  close(): Promise<void>;
  on(
    event: "completed",
    listener: (job: Pick<MainWorkerJob, "data" | "name">) => void,
  ): unknown;
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
  createRequestWorker(
    processor: (
      job: WorkerRequestJob,
      token?: string,
      signal?: AbortSignal,
    ) => Promise<WorkerReply>,
    options: { concurrency: number; lockDuration: number },
  ): JobWorker;
  faviconRefresher: Pick<
    FaviconRefresher,
    "enqueueRefreshes" | "refreshFavicon"
  >;
  feedParser: Pick<FeedParser, "discoverAndSubscribeWebSub" | "parseSource">;
  jobHandlers: WorkerJobHandlers;
  requestHandlers: WorkerRequestHandlers;
  retentionService: Pick<RetentionService, "prune">;
  sourceEnqueuer: Pick<
    SourceEnqueuer,
    "enqueueDueSources" | "requeuePendingRefresh" | "runParse"
  >;
  sourcesDataService: Pick<
    SourcesDataService,
    "findSourceById" | "getSourcesDueFaviconRefresh" | "getSourcesToProcess"
  >;
  webSubSubscriber: Pick<WebSubSubscriber, "renewDue">;
};

const workerRequestConcurrency = 8;

export class MainWorker {
  private worker: JobWorker | undefined;
  private requestWorker: JobWorker | undefined;

  constructor(private readonly services: MainWorkerServices) {}

  async initialize() {
    await this.setupScheduledTasks();
    await this.enqueueDueSources();
    await Promise.all([
      this.startWorker().waitUntilReady(),
      this.startRequestWorker().waitUntilReady(),
    ]);
  }

  async cleanup() {
    await Promise.all([this.worker?.close(), this.requestWorker?.close()]);
  }

  private async enqueueDueSources() {
    const { sourceEnqueuer, sourcesDataService } = this.services;
    await sourceEnqueuer.enqueueDueSources(
      await sourcesDataService.getSourcesToProcess(),
    );
  }

  private readonly processJob = async (job: MainWorkerJob) => {
    try {
      await this.runJob(job);
    } catch (error: unknown) {
      if (await this.deferred(job, error)) throw new DelayedError();
    }
  };

  private async deferred(job: MainWorkerJob, error: unknown) {
    try {
      if (!(error instanceof HttpDeferredError)) throw error;
      if (error instanceof JobDeferral) await job.updateData(error.data);
      await job.moveToDelayed(error.retryAt, job.token);
      return true;
    } catch {
      try {
        console.error(`Error processing ${job.name} job:`, error);
      } catch {}
      return false;
    }
  }

  private async runJob(job: MainWorkerJob) {
    const {
      faviconRefresher,
      feedParser,
      jobHandlers,
      retentionService,
      sourceEnqueuer,
      sourcesDataService,
      webSubSubscriber,
    } = this.services;
    const handler = jobHandlers.get(job.name);
    if (handler) {
      await handler(job.data);
      return;
    }
    const input = { data: job.data, name: job.name };
    if (!mainWorkerJobCheck.Check(input)) {
      throw new Error(`Invalid job payload for type: ${job.name}`);
    }

    switch (input.name) {
      case JobName.Cleanup: {
        await retentionService.prune();
        break;
      }

      case JobName.DiscoverWebSub: {
        const source = await sourcesDataService.findSourceById(input.data.id);
        if (!source || source.kind === "email") break;
        await feedParser.discoverAndSubscribeWebSub(
          source.id,
          source.url,
          source.websubStatus,
        );
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
        await sourceEnqueuer.runParse(input.data, async (request) => {
          const source = await sourcesDataService.findSourceById(request.id);
          if (!source) {
            throw new Error(`Source with ID ${request.id} not found`);
          }
          if (source.kind === "email") return;
          await feedParser.parseSource({ ...source, ...request });
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

  private async requeuePendingRefresh(
    job: Pick<MainWorkerJob, "data" | "name">,
  ) {
    const input = { data: job.data, name: job.name };
    if (!mainWorkerJobCheck.Check(input)) return;
    if (input.name !== JobName.ParseSource) return;
    try {
      await this.services.sourceEnqueuer.requeuePendingRefresh(input.data.id);
    } catch (error) {
      console.error(`Error requeueing ${job.name} job:`, error);
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
    worker.on("completed", (job) => {
      void this.requeuePendingRefresh(job);
    });
    worker.on("failed", (job, error) => {
      console.error(`Worker job failed: ${job?.id ?? "unknown"}`, error);
    });
    this.worker = worker;

    console.log("Worker pool setup complete");
    return worker;
  }

  private startRequestWorker() {
    const { config: appConfig, requestHandlers } = this.services;
    const worker = this.services.createRequestWorker(
      async (job, _token, signal) =>
        answerWorkerRequest(job, requestHandlers, signal),
      {
        concurrency: workerRequestConcurrency,
        lockDuration: appConfig.LOCK_DURATION * 1_000,
      },
    );
    worker.on("failed", (job, error) => {
      console.error(`Worker request failed: ${job?.id ?? "unknown"}`, error);
    });
    this.requestWorker = worker;
    return worker;
  }
}

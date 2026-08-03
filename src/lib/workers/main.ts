import { Type } from "typebox";
import Schema from "typebox/schema";
import { DelayedError } from "bullmq";
import type { AppConfig } from "../../config.ts";
import type { SourcesDataService } from "../../db/data-services/source-data-service.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import { JobName } from "../../types/job-name-enum.ts";
import type { FeedParser } from "../feed-parser.ts";
import { HttpDeferredError } from "../http-client.ts";
import { webUrlPolicy } from "../typebox-policy.ts";

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
]);
const mainWorkerJobCheck = Schema.Compile(mainWorkerJobData);

type QueueOptions = {
  jobId?: string;
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
  | "GATHER_JOBS_INTERVAL"
  | "LOCK_DURATION"
  | "WORKER_CONCURRENCY"
>;

type MainWorkerSources = Pick<
  SourcesDataService,
  "findSourceById" | "getRecentlySuccessfulSources" | "getSourcesToProcess"
>;

export class MainWorker {
  private worker: WorkerControls | undefined;

  constructor(
    private readonly appConfig: MainWorkerConfig,
    private readonly bullmqQueue: MainWorkerQueue,
    private readonly feedParser: Pick<
      FeedParser,
      "parseSource" | "refreshFavicon"
    >,
    private readonly sourcesDataService: MainWorkerSources,
    private readonly userSourcesDataService: Pick<
      UserSourcesDataService,
      "cleanup"
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
          await this.userSourcesDataService.cleanup();
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
          });
          break;
        }

        case JobName.RefreshFavicon: {
          await this.feedParser.refreshFavicon(input.data);
          break;
        }
      }
    } catch (error: unknown) {
      if (error instanceof HttpDeferredError) {
        await job.moveToDelayed(error.retryAt, job.token);
        throw new DelayedError();
      }
      console.error("Error processing job:", error);
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

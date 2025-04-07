import type { CommandBus } from "$lib/commands/command-bus";
import {
  CommandType,
  type ParseSourceCommand,
  type SourceCommandResult,
} from "$lib/commands/types";
import type { SourcesRepository } from "$lib/db/source-repository";
import { type Job, type Queue, Worker } from "bullmq";
import type Redis from "ioredis";
import type { AppConfig } from "../../config.ts";
import { JobName } from "../../types/job-name-enum.ts";
import { llog, logError } from "../../util/log.ts";

export class MainWorker {
  private worker: undefined | Worker;

  constructor(
    private readonly appConfig: AppConfig,
    private readonly bullmqQueue: Queue | null,
    private readonly redis: Redis | null,
    private readonly sourcesRepository: SourcesRepository,
    private readonly commandBus: CommandBus,
  ) {}

  async initialize() {
    llog("Initializing worker");
    this.setupWorker();
    this.setSignalHandlers();
    await this.setupScheduledTasks();
    llog("Worker initialized and tasks scheduled");

    // Gather parse source jobs on startup
    await this.gatherParseSourceJobs();
  }

  private async gatherParseSourceJobs() {
    const sources = await this.sourcesRepository.getSourcesToProcess();
    llog(`Found ${sources.length} sources to process`);

    return sources.map((source) => {
      return {
        data: source,
        jobId: `${JobName.ParseSource}:${source.id}`,
        name: JobName.ParseSource,
        opts: {
          jobId: `${JobName.ParseSource}:${source.id}`,
          removeOnComplete: { count: 0 },
          removeOnFail: { count: 0 },
        },
      };
    });
  }

  private async processJob(
    job: Job<ParseSourceCommand>,
  ): Promise<SourceCommandResult> {
    if (!this.bullmqQueue) {
      return { success: false, error: new Error("Queue not available") };
    }

    try {
      const command: ParseSourceCommand = {
        sourceId: job.data.sourceId,
        timestamp: Date.now(),
        type: CommandType.PARSE_SOURCE,
      };

      const result = await this.commandBus.execute(command);
      return result;
    } catch (error) {
      logError(`Error processing job ${job.id}:`, error);
      return { success: false, error: new Error("Internal server error") };
    }
  }

  private setSignalHandlers() {
    process.on("SIGTERM", () => {
      (async () => {
        if (this.worker) {
          await this.worker.close();
          llog("Worker closed gracefully");
        }
      })();
    });
  }

  private async setupScheduledTasks() {
    if (!this.bullmqQueue) {
      return;
    }

    llog(
      `Setting up scheduled tasks - Cleanup interval: ${this.appConfig["CLEANUP_INTERVAL"]} minutes, Gather interval: ${this.appConfig["GATHER_JOBS_INTERVAL"]} minutes`,
    );

    // Schedule cleanup job
    await this.bullmqQueue.add(
      JobName.Cleanup,
      {},
      {
        jobId: JobName.Cleanup,
        repeat: {
          every: this.appConfig["CLEANUP_INTERVAL"] * 60 * 1_000,
        },
      },
    );
    llog("Scheduled cleanup job");

    // Schedule gather job
    await this.bullmqQueue.add(
      JobName.GatherJobs,
      {},
      {
        jobId: JobName.GatherJobs,
        repeat: {
          every: this.appConfig["GATHER_JOBS_INTERVAL"] * 60 * 1_000,
        },
      },
    );
    llog("Scheduled gather jobs");

    // Schedule favicon job
    await this.bullmqQueue.add(
      JobName.GatherFaviconJobs,
      {},
      {
        jobId: JobName.GatherFaviconJobs,
        repeat: {
          every: 24 * 60 * 60 * 1_000,
        },
      },
    );
    llog("Scheduled favicon jobs");
  }

  private setupWorker() {
    if (!this.redis) {
      return;
    }

    llog(
      `Setting up worker with concurrency: ${this.appConfig["WORKER_CONCURRENCY"]}, lock duration: ${this.appConfig["LOCK_DURATION"]} seconds`,
    );

    const worker = new Worker("tasks", this.processJob.bind(this), {
      autorun: true,
      concurrency: this.appConfig["WORKER_CONCURRENCY"],
      connection: this.redis,
      lockDuration: this.appConfig["LOCK_DURATION"] * 1_000,
    });

    // Set up minimal event listeners for the worker
    worker.on("failed", (job: Job | undefined, error: Error) => {
      logError(`Worker job failed: ${job?.id ?? "unknown"}`, error);
    });

    this.worker = worker;
    llog("Worker setup complete");
  }

  public start() {
    this.setupWorker();
  }

  public stop() {
    if (this.worker) {
      void this.worker.close();
      this.worker = undefined;
    }
  }
}

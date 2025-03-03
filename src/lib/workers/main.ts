/* eslint-disable n/no-process-env */

import { type CommandBus } from "$lib/commands/command-bus";
import {
  CommandType,
  type ParseSourceCommand,
  type SourceCommandResult,
} from "$lib/commands/types";
import { type SourcesRepository } from "$lib/db/source-repository";
import { type UserSourcesRepository } from "$lib/db/user-source-repository";
import { type FeedParser } from "$lib/feed-parser";
import { JobName } from "../../types/job-name-enum";
import { llog, logError } from "../../util/log";
import { type Job, type Queue, Worker } from "bullmq";
import type Redis from "ioredis";

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
};

const DEFAULT_CLEANUP_INTERVAL = 60;
const DEFAULT_GATHER_INTERVAL = 20;
const DEFAULT_LOCK_DURATION = 60;
const DEFAULT_WORKER_CONCURRENCY = 25;

export class MainWorker {
  private worker: undefined | Worker;

  constructor(
    private readonly bullmqQueue: Queue,
    private readonly feedParser: FeedParser,
    private readonly redis: Redis,
    private readonly sourcesRepository: SourcesRepository,
    private readonly userSourcesRepository: UserSourcesRepository,
    private readonly commandBus: CommandBus,
  ) {}

  async initialize() {
    llog("Initializing worker");
    this.setupWorker();
    this.setSignalHandlers();
    await this.setupScheduledTasks();
    llog("Worker initialized and tasks scheduled");

    // Log queue status every minute
    setInterval(() => {
      void this.logQueueStatus();
    }, 60_000);

    // Gather parse source jobs on startup
    await this.gatherParseSourceJobs();
  }

  private async gatherParseSourceJobs() {
    const sources = await this.sourcesRepository.getSourcesToProcess();
    llog(`Found ${sources.length} sources to process`);

    return sources.map((source) => {
      return {
        data: source,
        jobId: JobName.PARSE_SOURCE + ":" + source.id,
        name: JobName.PARSE_SOURCE,
        opts: {
          jobId: JobName.PARSE_SOURCE + ":" + source.id,
          removeOnComplete: { count: 0 },
          removeOnFail: { count: 0 },
        },
      };
    });
  }

  private handleJobError(error: unknown, job: Job) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(`Error processing job: ${job.name}, ID: ${job.id}`, error);
    if (job) {
      llog(`Worker failed job ${job.id} with error: ${errorMessage}`);
    } else {
      llog(`Worker failed unknown job with error: ${errorMessage}`);
    }
  }

  private async logQueueStatus(): Promise<void> {
    try {
      const status = await this.bullmqQueue.getJobCounts();
      llog(
        `Queue status - Waiting: ${status["waiting"]}, Active: ${status["active"]}, Delayed: ${status["delayed"]}, Completed: ${status["completed"]}, Failed: ${status["failed"]}`,
      );
    } catch (error) {
      logError(
        "Error getting queue status: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private readonly processJob = async (job: Job) => {
    llog(
      `Processing job: ${job.name}, ID: ${job.id}, Data: ${JSON.stringify(job.data)}`,
    );
    try {
      await this.processRegularJob(job);

      llog(`Successfully processed job: ${job.name}, ID: ${job.id}`);
      return true;
    } catch (error: unknown) {
      this.handleJobError(error, job);
      // intentionally, no need to put the failed job back on the queue as it will be scheduled to be performed again in due time
      return true;
    }
  };

  private async processRegularJob(job: Job) {
    switch (job.name) {
      case JobName.CLEANUP:
        llog("Running cleanup job");
        await this.bullmqQueue.trimEvents(100);
        await this.userSourcesRepository.cleanup();
        llog("Cleanup job completed");
        break;
      case JobName.GATHER_FAVICON_JOBS: {
        llog("Running gather favicon jobs");
        const successfullSources =
          await this.sourcesRepository.getRecentlySuccessfulSources();
        llog(`Found ${successfullSources.length} sources for favicon refresh`);
        const tasks = successfullSources.map((source) => {
          return {
            data: source,
            jobId: JobName.REFRESH_FAVICON + ":" + source.homeUrl,
            name: JobName.REFRESH_FAVICON,
            opts: {
              jobId: JobName.REFRESH_FAVICON + ":" + source.homeUrl,
              removeOnComplete: { count: 0 },
              removeOnFail: { count: 0 },
            },
          };
        });
        await this.bullmqQueue.addBulk(tasks);
        llog(`Added ${tasks.length} favicon refresh jobs to queue`);
        break;
      }

      case JobName.GATHER_JOBS: {
        llog("Running gather jobs");
        const parseSourceJobs = await this.gatherParseSourceJobs();
        await this.bullmqQueue.addBulk(parseSourceJobs);
        llog(`Added ${parseSourceJobs.length} parse source jobs to queue`);
        break;
      }

      case JobName.PARSE_SOURCE:
        llog(`Parsing source with ID: ${job.data.id}`);
        // Use the command bus instead of directly calling the feed parser
        await this.commandBus.execute<ParseSourceCommand, SourceCommandResult>({
          sourceId: job.data.id,
          timestamp: Date.now(),
          type: CommandType.PARSE_SOURCE,
        });
        llog(`Completed parsing source with ID: ${job.data.id}`);
        break;
      case JobName.REFRESH_FAVICON:
        llog(`Refreshing favicon for: ${job.data.homeUrl}`);
        await this.feedParser.refreshFavicon(job.data);
        llog(`Completed refreshing favicon for: ${job.data.homeUrl}`);
        break;
      default:
        throw new Error(`Unknown job type: ${job.name}`);
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
    const cleanupInterval = parseNumber(
      process.env["CLEANUP_INTERVAL"],
      DEFAULT_CLEANUP_INTERVAL,
    );
    const gatherInterval = parseNumber(
      process.env["GATHER_INTERVAL"],
      DEFAULT_GATHER_INTERVAL,
    );

    llog(
      `Setting up scheduled tasks - Cleanup interval: ${cleanupInterval} minutes, Gather interval: ${gatherInterval} minutes`,
    );

    // Schedule cleanup job
    await this.bullmqQueue.add(
      JobName.CLEANUP,
      {},
      {
        jobId: JobName.CLEANUP,
        repeat: {
          every: cleanupInterval * 60 * 1_000,
        },
      },
    );
    llog("Scheduled cleanup job");

    // Schedule gather job
    await this.bullmqQueue.add(
      JobName.GATHER_JOBS,
      {},
      {
        jobId: JobName.GATHER_JOBS,
        repeat: {
          every: gatherInterval * 60 * 1_000,
        },
      },
    );
    llog("Scheduled gather jobs");

    // Schedule favicon job
    await this.bullmqQueue.add(
      JobName.GATHER_FAVICON_JOBS,
      {},
      {
        jobId: JobName.GATHER_FAVICON_JOBS,
        repeat: {
          every: 24 * 60 * 60 * 1_000,
        },
      },
    );
    llog("Scheduled favicon jobs");
  }

  private setupWorker() {
    const concurrency = parseNumber(
      process.env["WORKER_CONCURRENCY"],
      DEFAULT_WORKER_CONCURRENCY,
    );
    const lockDuration = parseNumber(
      process.env["LOCK_DURATION"],
      DEFAULT_LOCK_DURATION,
    );

    llog(
      `Setting up worker with concurrency: ${concurrency}, lock duration: ${lockDuration} seconds`,
    );

    this.worker = new Worker("tasks", this.processJob, {
      autorun: true,
      concurrency,
      connection: this.redis,
      lockDuration: lockDuration * 1_000,
    });

    // Set up minimal event listeners for the worker
    this.worker.on("failed", (job: Job | undefined, error: Error) => {
      logError(`Worker job failed: ${job?.id ?? "unknown"}`, error);
    });

    llog("Worker setup complete");
  }
}

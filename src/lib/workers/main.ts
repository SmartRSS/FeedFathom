import type { CommandBus } from "$lib/commands/command-bus";
import {
  CommandType,
  type ParseSourceCommand,
  type SourceCommandResult,
} from "$lib/commands/types";
import type { SourcesRepository } from "$lib/db/source-repository";
import type { UserSourcesRepository } from "$lib/db/user-source-repository";
import type { FeedParser } from "$lib/feed-parser";
import type { AppConfig } from "../../config.ts";
import { JobName } from "../../types/job-name-enum.ts";
import { llog, logError } from "../../util/log.ts";
import type { SimpleQueue } from "../simple-queue.ts";

export class MainWorker {
  constructor(
    private readonly appConfig: AppConfig,
    private readonly feedParser: FeedParser,
    private readonly sourcesRepository: SourcesRepository,
    private readonly userSourcesRepository: UserSourcesRepository,
    private readonly commandBus: CommandBus,
    private readonly simpleQueue: SimpleQueue,
  ) {
    // Cast Redis to RedisClient for SimpleQueue
  }

  async initialize() {
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

    for (const source of sources) {
      const jobId = `${JobName.ParseSource}:${source.id}`;
      await this.simpleQueue.addJobToQueue({
        generalId: jobId,
        instanceId: jobId,
        name: JobName.ParseSource,
        payload: source,
        every: 0, // Not a repeating job
      });
    }
  }

  private handleJobError(error: unknown, jobId: string) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(`Error processing job: ${jobId}`, error);
    llog(`Worker failed job ${jobId} with error: ${errorMessage}`);
  }

  private readonly processJob = async (jobData: Record<string, unknown>) => {
    const jobId =
      (jobData["generalId"] as string) ||
      (jobData["instanceId"] as string) ||
      "unknown";
    const jobName = jobData["name"] as JobName;
    const data = (jobData["payload"] as Record<string, unknown>) || {};

    llog(
      `Processing job: ${jobName}, ID: ${jobId}, Data: ${JSON.stringify(data)}`,
    );

    try {
      await this.processRegularJob(jobName, data);
      llog(`Successfully processed job: ${jobName}, ID: ${jobId}`);
    } catch (error: unknown) {
      this.handleJobError(error, jobId);
      // intentionally, no need to put the failed job back on the queue as it will be scheduled to be performed again in due time
    }
  };

  private async processRegularJob(
    jobName: JobName,
    data: Record<string, unknown>,
  ) {
    switch (jobName) {
      case JobName.Cleanup: {
        llog("Running cleanup job");
        await this.userSourcesRepository.cleanup();
        llog("Cleanup job completed");
        break;
      }

      case JobName.GatherFaviconJobs: {
        llog("Running gather favicon jobs");
        const successfullSources =
          await this.sourcesRepository.getRecentlySuccessfulSources();
        llog(`Found ${successfullSources.length} sources for favicon refresh`);

        for (const source of successfullSources) {
          const jobId = `${JobName.RefreshFavicon}:${source.homeUrl}`;
          await this.simpleQueue.addJobToQueue({
            generalId: jobId,
            instanceId: jobId,
            name: JobName.RefreshFavicon,
            payload: source,
            every: 0, // Not a repeating job
          });
        }

        llog(
          `Added ${successfullSources.length} favicon refresh jobs to queue`,
        );
        break;
      }

      case JobName.GatherJobs: {
        llog("Running gather jobs");
        await this.gatherParseSourceJobs();
        llog("Added parse source jobs to queue");
        break;
      }

      case JobName.ParseSource: {
        const sourceId = data["id"] as string;
        llog(`Parsing source with ID: ${sourceId}`);
        // Use the command bus instead of directly calling the feed parser
        await this.commandBus.execute<ParseSourceCommand, SourceCommandResult>({
          sourceId,
          timestamp: Date.now(),
          type: CommandType.PARSE_SOURCE,
        });
        llog(`Completed parsing source with ID: ${sourceId}`);
        break;
      }

      case JobName.RefreshFavicon: {
        const homeUrl = data["homeUrl"] as string;
        llog(`Refreshing favicon for: ${homeUrl}`);
        await this.feedParser.refreshFavicon(
          data as { homeUrl: string; id: number },
        );
        llog(`Completed refreshing favicon for: ${homeUrl}`);
        break;
      }

      default:
        throw new Error(`Unknown job type: ${jobName}`);
    }
  }

  private setSignalHandlers() {
    process.on("SIGTERM", () => {
      (() => {
        this.simpleQueue.stopProcessing();
        llog("Worker closed gracefully");
      })();
    });
  }

  private async setupScheduledTasks() {
    llog(
      `Setting up scheduled tasks - Cleanup interval: ${this.appConfig["CLEANUP_INTERVAL"]} minutes, Gather interval: ${this.appConfig["GATHER_JOBS_INTERVAL"]} minutes`,
    );

    // Schedule cleanup job
    await this.simpleQueue.scheduleJob({
      id: JobName.Cleanup,
      name: JobName.Cleanup,
      every: this.appConfig["CLEANUP_INTERVAL"] * 60,
      payload: {},
    });
    llog("Scheduled cleanup job");

    // Schedule gather job
    await this.simpleQueue.scheduleJob({
      id: JobName.GatherJobs,
      name: JobName.GatherJobs,
      every: this.appConfig["GATHER_JOBS_INTERVAL"] * 60,
      payload: {},
    });
    llog("Scheduled gather jobs");

    // Schedule favicon job
    await this.simpleQueue.scheduleJob({
      id: JobName.GatherFaviconJobs,
      name: JobName.GatherFaviconJobs,
      every: 24 * 60 * 60, // 24 hours in seconds
      payload: {},
    });
    llog("Scheduled favicon jobs");
  }

  private setupWorker() {
    llog(
      `Setting up worker with concurrency: ${this.appConfig["WORKER_CONCURRENCY"]}`,
    );

    const startQueueProcessing = () => {
      this.simpleQueue.startProcessing(this.processJob, 1);

      // Set up a periodic check to restart processing if it stops
      setInterval(() => {
        if (!this.simpleQueue.isProcessing()) {
          llog("Queue processing stopped, restarting...");
          this.simpleQueue.startProcessing(this.processJob, 1);
        }
      }, 5000); // Check every 5 seconds
    };

    startQueueProcessing();
    llog("Worker setup complete");
  }
}

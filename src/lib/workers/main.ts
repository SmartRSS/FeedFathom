import type { CommandBus } from "$lib/commands/command-bus";
import {
  CommandType,
  type ParseSourceCommand,
  type SourceCommandResult,
} from "$lib/commands/types";
import type { SourcesRepository } from "$lib/db/source-repository";
import type { UserSourcesRepository } from "$lib/db/user-source-repository";
import type { FeedParser } from "$lib/feed-parser";
import type { JobHandler, PostgresQueue } from "$lib/postgres-queue";
import { type } from "arktype";
import type { AppConfig } from "../../config.ts";
import { JobName } from "../../types/job-name-enum.ts";
import { llog, logError } from "../../util/log.ts";

const parseSourcePayloadValidator = type({
  id: "number",
  skipCache: "boolean?",
  url: "string?",
  "+": "reject",
});

const refreshFaviconPayloadValidator = type({
  homeUrl: "string",
  id: "number",
  "+": "reject",
});

export class MainWorker {
  constructor(
    private readonly appConfig: AppConfig,
    private readonly feedParser: FeedParser,
    private readonly sourcesRepository: SourcesRepository,
    private readonly userSourcesRepository: UserSourcesRepository,
    private readonly commandBus: CommandBus,
    private readonly postgresQueue: PostgresQueue,
  ) {}

  async initialize() {
    this.setSignalHandlers();
    await this.setupScheduledTasks();
    this.startWorker();
  }

  private async gatherParseSourceJobs() {
    const sources = await this.sourcesRepository.getSourcesToProcess();
    llog(`Found ${sources.length} sources to process`);

    for (const source of sources) {
      const jobId = `${JobName.ParseSource}:${source.id}`;
      await this.postgresQueue.addJobToQueue({
        generalId: jobId,
        name: JobName.ParseSource,
        payload: source,
      });
    }
  }

  private handleJobError(error: unknown, jobId: string) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(`Error processing job: ${jobId}`, error);
    llog(`Worker failed job ${jobId} with error: ${errorMessage}`);
  }

  private readonly processJob: JobHandler = async (jobData) => {
    const jobId = jobData.generalId;
    const jobName = jobData.name;
    const data = jobData.payload;

    llog(
      `Processing job: ${jobName}, ID: ${jobId}, Data: ${JSON.stringify(data)}`,
    );

    try {
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
          llog(
            `Found ${successfullSources.length} sources for favicon refresh`,
          );

          for (const source of successfullSources) {
            const jobId = `${JobName.RefreshFavicon}:${source.homeUrl}`;
            await this.postgresQueue.addJobToQueue({
              generalId: jobId,
              name: JobName.RefreshFavicon,
              payload: source,
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
          const validatedPayload = parseSourcePayloadValidator(data);
          if (validatedPayload instanceof type.errors) {
            throw new Error(
              `Invalid ParseSource payload: ${JSON.stringify(validatedPayload)}`,
            );
          }
          llog(`Parsing source with ID: ${validatedPayload.id}`);
          // Use the command bus instead of directly calling the feed parser
          await this.commandBus.execute<
            ParseSourceCommand,
            SourceCommandResult
          >({
            sourceId: validatedPayload.id.toString(),
            timestamp: Date.now(),
            type: CommandType.PARSE_SOURCE,
          });
          llog(`Completed parsing source with ID: ${validatedPayload.id}`);
          break;
        }

        case JobName.RefreshFavicon: {
          const validatedPayload = refreshFaviconPayloadValidator(data);
          if (validatedPayload instanceof type.errors) {
            throw new Error(
              `Invalid RefreshFavicon payload: ${JSON.stringify(validatedPayload)}`,
            );
          }
          llog(`Refreshing favicon for: ${validatedPayload.homeUrl}`);
          await this.feedParser.refreshFavicon(validatedPayload);
          llog(`Completed refreshing favicon for: ${validatedPayload.homeUrl}`);
          break;
        }

        default:
          throw new Error(`Unknown job type: ${jobName}`);
      }
      llog(`Successfully processed job: ${jobName}, ID: ${jobId}`);
    } catch (error: unknown) {
      this.handleJobError(error, jobId);
      // intentionally, no need to put the failed job back on the queue as it will be scheduled to be performed again in due time
    }
  };

  private setSignalHandlers() {
    process.on("SIGTERM", () => {
      (() => {
        this.postgresQueue.stopProcessing();
        llog("Worker closed gracefully");
      })();
    });
  }

  private async setupScheduledTasks() {
    llog(
      `Setting up scheduled tasks - Cleanup interval: ${this.appConfig["CLEANUP_INTERVAL"]} seconds, Gather interval: ${this.appConfig["GATHER_JOBS_INTERVAL"]} seconds`,
    );

    llog("Scheduling cleanup job");
    // Schedule cleanup job
    await this.postgresQueue.scheduleJob({
      generalId: JobName.Cleanup,
      name: JobName.Cleanup,
      every: this.appConfig["CLEANUP_INTERVAL"],
      payload: {},
    });
    llog("Scheduled cleanup job");

    llog("Scheduling gather job");
    // Schedule gather job
    await this.postgresQueue.scheduleJob({
      generalId: JobName.GatherJobs,
      name: JobName.GatherJobs,
      every: this.appConfig["GATHER_JOBS_INTERVAL"],
      payload: {},
    });
    llog("Scheduled gather job");

    llog("Scheduling favicon jobs");
    // Schedule favicon job
    await this.postgresQueue.scheduleJob({
      generalId: JobName.GatherFaviconJobs,
      name: JobName.GatherFaviconJobs,
      every: 24 * 60 * 60, // 24 hours in seconds
      payload: {},
    });
    llog("Scheduled favicon jobs");
  }

  private startWorker() {
    llog(
      `Setting up worker with concurrency: ${this.appConfig["WORKER_CONCURRENCY"]}`,
    );
    this.postgresQueue.startProcessing(this.processJob, 1);
    llog("Worker setup complete");
  }
}

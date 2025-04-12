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

    for (const source of sources) {
      const jobId = `${JobName.ParseSource}:${source.id}`;
      await this.postgresQueue.addJobToQueue({
        generalId: jobId,
        name: JobName.ParseSource,
        payload: source,
      });
    }
  }

  private handleJobError(error: unknown) {
    logError("Error processing job:", error);
  }

  private readonly processJob: JobHandler = async (jobData) => {
    const jobName = jobData.name;
    const data = jobData.payload;

    try {
      switch (jobName) {
        case JobName.Cleanup: {
          await this.userSourcesRepository.cleanup();
          break;
        }

        case JobName.GatherFaviconJobs: {
          const successfullSources =
            await this.sourcesRepository.getRecentlySuccessfulSources();

          for (const source of successfullSources) {
            const jobId = `${JobName.RefreshFavicon}:${source.homeUrl}`;
            await this.postgresQueue.addJobToQueue({
              generalId: jobId,
              name: JobName.RefreshFavicon,
              payload: source,
            });
          }

          break;
        }

        case JobName.GatherJobs: {
          await this.gatherParseSourceJobs();
          break;
        }

        case JobName.ParseSource: {
          const validatedPayload = parseSourcePayloadValidator(data);
          if (validatedPayload instanceof type.errors) {
            throw new Error(
              `Invalid ParseSource payload: ${JSON.stringify(validatedPayload)}`,
            );
          }
          // Use the command bus instead of directly calling the feed parser
          await this.commandBus.execute<
            ParseSourceCommand,
            SourceCommandResult
          >({
            sourceId: validatedPayload.id.toString(),
            timestamp: Date.now(),
            type: CommandType.PARSE_SOURCE,
          });
          break;
        }

        case JobName.RefreshFavicon: {
          const validatedPayload = refreshFaviconPayloadValidator(data);
          if (validatedPayload instanceof type.errors) {
            throw new Error(
              `Invalid RefreshFavicon payload: ${JSON.stringify(validatedPayload)}`,
            );
          }
          await this.feedParser.refreshFavicon(validatedPayload);
          break;
        }

        default:
          throw new Error(`Unknown job type: ${jobName}`);
      }
    } catch (error: unknown) {
      this.handleJobError(error);
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
    await this.postgresQueue.scheduleJob({
      generalId: JobName.Cleanup,
      name: JobName.Cleanup,
      every: this.appConfig["CLEANUP_INTERVAL"],
      payload: {},
    });

    await this.postgresQueue.scheduleJob({
      generalId: JobName.GatherJobs,
      name: JobName.GatherJobs,
      every: this.appConfig["GATHER_JOBS_INTERVAL"],
      payload: {},
    });

    await this.postgresQueue.scheduleJob({
      generalId: JobName.GatherFaviconJobs,
      name: JobName.GatherFaviconJobs,
      every: 24 * 60 * 60, // 24 hours in seconds
      payload: {},
    });
  }

  private startWorker() {
    llog(
      `Setting up worker with concurrency: ${this.appConfig["WORKER_CONCURRENCY"]}`,
    );
    this.postgresQueue.startProcessing(this.processJob, 1);
    llog("Worker setup complete");
  }
}

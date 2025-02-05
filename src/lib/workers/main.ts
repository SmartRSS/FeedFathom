import { type Job, type Queue, Worker } from "bullmq";
import { err, llog } from "../../util/log";
import type { FeedParser } from "$lib/feed-parser";
import type { UserSourceRepository } from "$lib/db/user-source-repository";
import type Redis from "ioredis";
import { JobName } from "../../types/job-name.enum";
import type { SourcesRepository } from "$lib/db/source-repository";
import { SingletonJobHandler } from "./singleton";

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return isNaN(parsed) || parsed <= 0 ? fallback : parsed;
};

type SingletonJobConfig = {
  name: JobName;
  delayMs: number;
};

const DEFAULT_WORKER_CONCURRENCY = 25;
const DEFAULT_LOCK_DURATION = 60;
const DEFAULT_CLEANUP_INTERVAL = 60;
const DEFAULT_GATHER_INTERVAL = 20;

const SINGLETON_JOBS: readonly SingletonJobConfig[] = [
  {
    name: JobName.SINGLETON_TEST_JOB,
    delayMs: 10000,
  }
] as const;

export class MainWorker {
  private worker: Worker | undefined;
  private singletonHandler: SingletonJobHandler;

  constructor(
    private readonly feedParser: FeedParser,
    private readonly userSourcesRepository: UserSourceRepository,
    private readonly redis: Redis,
    private readonly bullmqQueue: Queue,
    private readonly sourcesRepository: SourcesRepository,
  ) {
    this.singletonHandler = new SingletonJobHandler(redis);
  }

  async initialize() {
    this.setSignalHandlers();
    this.worker = this.setupWorker();
    await this.setupScheduledTasks();

    llog("Worker initialized and tasks scheduled");
  }

  private async gatherParseSourceJobs() {
    const sourcesToProcess = await this.sourcesRepository.getSourcesToProcess();
    return sourcesToProcess.map((source) => ({
      name: JobName.PARSE_SOURCE,
      jobId: JobName.PARSE_SOURCE + ":" + source.url,
      data: source,
      opts: {
        jobId: JobName.PARSE_SOURCE + ":" + source.url,
        removeOnComplete: true, // remove all completed jobs, no need to store them
        removeOnFail: true, // Intentional: Avoid retrying failed jobs. Failures are temporary and jobs are rescheduled by external task logic.
      },
    }));
  }

  private setupWorker() {
    const config = {
      connection: this.redis,
      concurrency: parseNumber(
        process.env["WORKER_CONCURRENCY"],
        DEFAULT_WORKER_CONCURRENCY,
      ),
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 0 },
      lockDuration:
        parseNumber(process.env["LOCK_DURATION"], DEFAULT_LOCK_DURATION) * 1000,
    };

    const worker = new Worker(this.bullmqQueue.name, this.processJob, config);

    worker.on("error", this.handleWorkerError);
    return worker;
  }

  private handleWorkerError = (error: unknown, jobId?: string) => {
    if (error instanceof Error) {
      err(`Worker error for job ${jobId ?? "unknown"}: ${error.message}`, {
        stack: error.stack,
        jobId,
      });
    } else {
      err("workerError", { error, jobId });
    }
  };

  private async setupScheduledTasks() {
    await this.bullmqQueue.upsertJobScheduler(
      JobName.CLEANUP,
      {
        every:
          parseNumber(
            process.env["CLEANUP_INTERVAL"],
            DEFAULT_CLEANUP_INTERVAL,
          ) * 1000,
      },
      { name: JobName.CLEANUP },
    );

    await this.bullmqQueue.upsertJobScheduler(
      JobName.GATHER_JOBS,
      {
        every:
          parseNumber(
            process.env["GATHER_JOBS_INTERVAL"],
            DEFAULT_GATHER_INTERVAL,
          ) * 1000,
      },
      { name: JobName.GATHER_JOBS },
    );

    // Schedule all singleton jobs
    for (const job of SINGLETON_JOBS) {
      await this.bullmqQueue.upsertJobScheduler(
        job.name,
        { every: Math.floor(job.delayMs / 2) },
        { name: job.name, data: { jobName: job.name } },
      );
    }
  }

  private setSignalHandlers() {
    process.on("SIGTERM", async () => {
      if (this.worker) {
        await this.worker.close();
        llog("Worker closed gracefully");
      }
    });
  }

  private async processSingletonJob(job: Job) {
    const jobName = job.data.jobName as JobName;
    const jobConfig = SINGLETON_JOBS.find((job) => job.name === jobName);
    if (!jobConfig) {
      throw new Error(`Unknown singleton job configuration: ${jobName}`);
    }

    await this.singletonHandler.runSingleton(
      { key: jobName, delayMs: jobConfig.delayMs },
      () => this.executeSingletonJob(jobName),
    );

    return true;
  }

  private async executeSingletonJob(jobName: JobName) {
    switch (jobName) {
      case JobName.SINGLETON_TEST_JOB:
        break;
      default:
        throw new Error(`No handler for singleton job: ${jobName}`);
    }
  }

  private async processRegularJob(job: Job) {
    switch (job.name) {
      case JobName.GATHER_JOBS: {
        const parseSourceJobs = await this.gatherParseSourceJobs();
        await this.bullmqQueue.addBulk(parseSourceJobs);
        break;
      }
      case JobName.CLEANUP:
        await this.userSourcesRepository.cleanup();
        break;
      case JobName.PARSE_SOURCE:
        await this.feedParser.parseSource(job.data);
        break;
      default:
        throw new Error(`Unknown job type: ${job.name}`);
    }
  }

  private processJob = async (job: Job) => {
    try {
      if (job.name.startsWith("SINGLETON:")) {
        await this.processSingletonJob(job);
      } else {
        await this.processRegularJob(job);
      }

      llog("finished processing ", job.name, job.id);
      return true;
    } catch (error: unknown) {
      this.handleJobError(error, job);
      return true;
    }
  };

  private handleJobError(error: unknown, job: Job) {
    err(`failed processing job ${job.name}`);
    if (error instanceof Error) {
      err(error.message);
      err(error.cause);
    }
  }
}

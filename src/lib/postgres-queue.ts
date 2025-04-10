import { type } from "arktype";
import { eq, lte } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { JobName } from "../types/job-name-enum.ts";
import { llog, logError } from "../util/log.ts";
import { jobQueue } from "./schema.ts";

const scheduledJobPayloadValidator = type({
  every: "number.integer",
  "[string]": "unknown",
});

type JobData = {
  generalId: string;
  name: JobName;
  delay?: number;
  payload?: Record<string, unknown>;
};

export type JobHandler = (jobData: JobData) => Promise<void> | void;

interface ScheduleJobOptions {
  generalId: string;
  name: JobName;
  every: number;
  payload?: Record<string, unknown>;
}

export class PostgresQueue {
  private processing = false;

  constructor(private readonly drizzleConnection: BunSQLDatabase) {}

  /**
   * Check if we're in a build process
   */
  private isBuildProcess(): boolean {
    const isBuild = process.env["BUILD"] === "true";

    if (isBuild) {
      llog("Build process detected with env var:", {
        BUILD: process.env["BUILD"],
      });
    }

    return isBuild;
  }

  public isProcessing() {
    return this.processing;
  }

  /**
   * Add a job to the queue
   */
  async addJobToQueue(jobData: JobData): Promise<void> {
    // If we're in a build process, don't add jobs
    if (this.isBuildProcess()) {
      llog("Build process detected, skipping job add");
      return;
    }

    try {
      await this.drizzleConnection.insert(jobQueue).values({
        generalId: jobData.generalId,
        name: jobData.name,
        notBefore: new Date((jobData.delay ?? 0) * 1000 + Date.now()),
        payload: jobData.payload ?? {},
      });
      llog("Added job to queue:", {
        generalId: jobData.generalId,
        name: jobData.name,
        notBefore: new Date((jobData.delay ?? 0) * 1000 + Date.now()),
        payload: jobData.payload ?? {},
      });
    } catch (error) {
      // Log the error but don't treat it as fatal
      logError("Error adding job to queue:", error);
    }
  }

  /**
   * Schedule a job to run at regular intervals
   */
  async scheduleJob(options: ScheduleJobOptions): Promise<void> {
    const { generalId, name, every, payload = {} } = options;

    if (Number.isNaN(every) || every <= 0) {
      logError(
        `Invalid 'every' value for scheduled job ${generalId}: ${every}`
      );
      return;
    }

    await this.addJobToQueue({
      generalId,
      name,
      delay: 0, // Run immediately first time
      payload: {
        ...payload,
        every, // Include the interval in the payload for rescheduling
      },
    });
  }

  /**
   * Process jobs from the queue
   */
  async processJobs(handler: JobHandler): Promise<void> {
    // If we're in a build process, don't start processing
    if (this.isBuildProcess()) {
      llog("Build process detected, skipping queue processing");
      this.processing = false;
      return;
    }

    while (this.processing) {
      try {
        // Get the next job that's ready to run with a lock
        const now = new Date();
        let jobFound = false;

        // Use a transaction to ensure the lock is held until we're done with the job
        await this.drizzleConnection.transaction(async (tx) => {
          // Select with FOR UPDATE to lock the row
          const jobs = await tx
            .select()
            .from(jobQueue)
            .where(lte(jobQueue.notBefore, now))
            .orderBy(jobQueue.notBefore)
            .limit(1)
            .for("update");
          llog(jobs);

          if (jobs.length === 0) {
            return;
          }

          const job = jobs[0];
          if (!job) {
            return;
          }

          jobFound = true;

          // Process the job within the transaction
          const maybeScheduledPayload = scheduledJobPayloadValidator(
            job.payload
          );
          if (!(maybeScheduledPayload instanceof type.errors)) {
            // Reschedule the job before processing to ensure continuity
            await this.addJobToQueue({
              generalId: job.generalId,
              name: job.name as JobName,
              delay: maybeScheduledPayload.every,
              payload: job.payload as Record<string, unknown>,
            });
          }

          if (handler && typeof handler === "function") {
            await handler({
              generalId: job.generalId,
              name: job.name as JobName,
              payload: job.payload as Record<string, unknown>,
            });
          }

          // Delete the job after successful processing
          await tx.delete(jobQueue).where(eq(jobQueue.id, job.id));
        });

        // If no job was found, wait before checking again
        if (!jobFound) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        // Log the error and wait before retrying
        logError("Error in processJob:", error);
        llog("Error occurred, waiting before retry");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Start processing jobs with the specified handler
   */
  startProcessing(handler: JobHandler, numWorkers = 1): void {
    // If we're in a build process, don't start processing
    if (this.isBuildProcess()) {
      llog("Build process detected, skipping queue start");
      return;
    }

    this.processing = true;

    for (let i = 0; i < numWorkers; i++) {
      this.processJobs(handler).catch((error) =>
        logError("Worker error:", error)
      );
    }
  }

  /**
   * Stop processing jobs
   */
  stopProcessing(): void {
    this.processing = false;
  }
}

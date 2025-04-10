import { type } from "arktype";
import { eq, sql } from "drizzle-orm";
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
    } catch {
      // Do nothing
    }
  }

  /**
   * Schedule a job to run at regular intervals
   */
  async scheduleJob(options: ScheduleJobOptions): Promise<void> {
    const { generalId, name, every, payload = {} } = options;

    if (Number.isNaN(every) || every <= 0) {
      logError(
        `Invalid 'every' value for scheduled job ${generalId}: ${every}`,
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
        let jobFound = false;
        let jobToProcess: JobData | null = null;
        let scheduleInterval = 0;

        // Use a transaction only to select and delete the job
        await this.drizzleConnection.transaction(async (tx) => {
          try {
            // Select with FOR UPDATE to lock the row
            const jobs = await tx
              .select()
              .from(jobQueue)
              .where(sql`${jobQueue.notBefore} <= now()`)
              .orderBy(jobQueue.id)
              .limit(1)
              .for("update");

            if (jobs.length === 0) {
              return;
            }

            const job = jobs[0];
            if (!job) {
              return;
            }
            llog("Found job", job);

            // Delete the job from the queue
            await tx.delete(jobQueue).where(eq(jobQueue.id, job.id)).execute();
            llog("Deleted job", job);

            jobFound = true;

            // Check if this is a scheduled job that needs to be rescheduled
            const maybeScheduledPayload = scheduledJobPayloadValidator(
              job.payload,
            );

            if (!(maybeScheduledPayload instanceof type.errors)) {
              llog("Will reschedule job", {
                generalId: job.generalId,
                name: job.name,
                delay: maybeScheduledPayload.every,
                payload: job.payload,
              });

              scheduleInterval = maybeScheduledPayload.every;

              if (scheduleInterval > 0) {
                await this.addJobToQueue({
                  generalId: job.generalId,
                  name: job.name as JobName,
                  delay: scheduleInterval,
                  payload: (job.payload ?? {}) as Record<string, unknown>,
                });
              }
            }

            // Prepare job data for processing outside the transaction
            const jobData: JobData = {
              generalId: job.generalId,
              name: job.name as JobName,
              payload: job.payload as Record<string, unknown>,
            };

            // Assign to the outer variable
            jobToProcess = jobData;
          } catch {
            tx.rollback();
          }
        });

        // Process the job outside the transaction if one was found
        if (jobFound && jobToProcess) {
          try {
            // Use type assertion to help TypeScript
            const job = jobToProcess as JobData;

            llog("Processing job", {
              generalId: job.generalId,
              name: job.name,
              payload: job.payload,
            });

            // Reschedule the job if it's a scheduled job

            // Process the job
            if (handler && typeof handler === "function") {
              await handler(job);
            }
          } catch (error) {
            logError("Error processing job outside transaction:", error);
          }
        } else if (!jobFound) {
          // If no job was found, wait before checking again
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
        logError("Worker error:", error),
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

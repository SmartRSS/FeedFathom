import { type } from "arktype";
import { type ExtractTablesWithRelations, eq } from "drizzle-orm";
import type { BunSQLDatabase, BunSQLQueryResultHKT } from "drizzle-orm/bun-sql";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { JobName } from "../types/job-name-enum.ts";
import { llog, logError } from "../util/log.ts";
import { jobQueue } from "./schema.ts";

const scheduledJobPayloadValidator = type({
  every: "number.integer",
  "[string]": "unknown",
});

type Transaction = PgTransaction<
  BunSQLQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

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
    llog(
      {
        generalId: jobData.generalId,
        name: jobData.name,
        notBefore: new Date((jobData.delay ?? 0) * 1000 + Date.now()),
        payload: jobData.payload ?? {},
      },
      "adding to queue",
    );

    try {
      // Use ON CONFLICT DO NOTHING to handle race conditions efficiently
      // This is a single database operation that handles the race condition at the DB level
      await this.drizzleConnection
        .insert(jobQueue)
        .values({
          generalId: jobData.generalId,
          name: jobData.name,
          notBefore: new Date((jobData.delay ?? 0) * 1000 + Date.now()),
          payload: jobData.payload ?? {},
        })
        .onConflictDoNothing();
    } catch (error) {
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
   * Select and lock a job from the queue using an atomic operation
   */
  private async selectAndLockJob(
    tx: Transaction,
    now: Date,
    fiveMinutesAgo: Date,
  ) {
    const result = await tx.execute(`
      WITH selected_job AS (
        SELECT id
        FROM job_queue
        WHERE (locked_at IS NULL OR locked_at <= '${fiveMinutesAgo.toISOString()}')
          AND not_before <= '${now.toISOString()}'
        ORDER BY not_before ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE job_queue jq
      SET locked_at = '${now.toISOString()}'
      FROM selected_job sj
      WHERE jq.id = sj.id
      RETURNING jq.*
    `);

    return result?.[0] || null;
  }

  /**
   * Delete a job from the queue
   */
  private async deleteJob(tx: Transaction, jobId: number) {
    await tx.delete(jobQueue).where(eq(jobQueue.id, jobId));
  }

  /**
   * Reschedule a job if it's a periodic job
   */
  private async rescheduleJobIfNeeded(tx: Transaction, jobData: JobData) {
    const maybeScheduledPayload = scheduledJobPayloadValidator(jobData);

    if (!(maybeScheduledPayload instanceof type.errors)) {
      const newJobData: JobData = {
        generalId: jobData.generalId,
        name: jobData.name,
        delay: maybeScheduledPayload.every,
        payload: jobData.payload ?? {},
      };
      llog("Will reschedule job", newJobData);

      await tx.insert(jobQueue).values({
        generalId: newJobData.generalId,
        name: newJobData.name,
        notBefore: new Date((newJobData.delay ?? 0) * 1000 + Date.now()),
        payload: newJobData.payload ?? {},
      });
    }
  }

  /**
   * Pick a job from the queue using an atomic select-and-update operation
   * This method uses a CTE (Common Table Expression) to atomically select and lock a job
   */
  async pickJob() {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // Use a transaction to ensure atomicity
    return await this.drizzleConnection.transaction(async (tx) => {
      // Select and lock a job
      const job = await this.selectAndLockJob(tx, now, fiveMinutesAgo);

      if (!job) {
        return null;
      }

      const jobData = {
        generalId: job["generalId"] as string,
        name: job["name"] as JobName,
        payload: (typeof job["payload"] === "string"
          ? JSON.parse(job["payload"])
          : job["payload"]) as Record<string, unknown>,
      };

      console.log("jobData", JSON.stringify(jobData, null, 2));

      // Delete the job within the same transaction
      await this.deleteJob(tx, job["id"]);

      // Check if this is a scheduled job that needs to be rescheduled
      await this.rescheduleJobIfNeeded(tx, jobData);

      return jobData;
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
        // Use the pickJob method to atomically select and lock a job
        const jobData = await this.pickJob();

        if (!jobData) {
          // No job was available
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        // Process the job
        try {
          // Process the job
          if (handler && typeof handler === "function") {
            await handler(jobData);
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logError("Error processing job:", error);

          llog(`Job ${jobData.generalId} failed`, {
            error: errorMessage,
          });
        }
      } catch (error) {
        // Log the error and wait before retrying
        logError("Error in processJob:", error);
        llog("Error occurred, waiting before retry");
        await new Promise((resolve) => setTimeout(resolve, 1000));
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

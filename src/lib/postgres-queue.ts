import { type } from "arktype";
import { type ExtractTablesWithRelations, eq } from "drizzle-orm";
import type { BunSQLDatabase, BunSQLQueryResultHKT } from "drizzle-orm/bun-sql";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { MaintenanceState } from "../container.ts";
import { jobQueue } from "../db/schemas/jobQueue.ts";
import type { JobName } from "../types/job-name-enum.ts";
import { logError } from "../util/log.ts";

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

  constructor(
    private readonly drizzleConnection: BunSQLDatabase,
    private readonly maintenanceState: MaintenanceState,
  ) {}

  /**
   * Check if we're in a build process
   */
  private isBuildProcess(): boolean {
    return process.env["BUILD"] === "true";
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
      return;
    }

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
   * Select and lock jobs from the queue using an atomic operation
   */
  private async selectAndLockJobs(tx: Transaction, limit: number) {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // Optimized query with better indexing and batch processing
    const results = await tx.execute(`
      WITH selected_jobs AS (
        SELECT id
        FROM job_queue
        WHERE (locked_at IS NULL OR locked_at <= '${fiveMinutesAgo.toISOString()}')
          AND not_before <= '${now.toISOString()}'
        ORDER BY not_before ASC, id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE job_queue jq
      SET locked_at = '${now.toISOString()}'
      FROM selected_jobs sj
      WHERE jq.id = sj.id
      RETURNING jq.*
    `);

    return results || [];
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
    const maybeScheduledPayload = scheduledJobPayloadValidator(jobData.payload);

    if (maybeScheduledPayload instanceof type.errors) {
      return;
    }

    await tx.insert(jobQueue).values({
      generalId: jobData.generalId,
      name: jobData.name,
      notBefore: new Date(maybeScheduledPayload.every * 1000 + Date.now()),
      payload: jobData.payload ?? {},
    });
  }

  /**
   * Pick jobs from the queue using an atomic select-and-update operation
   * This method uses a CTE (Common Table Expression) to atomically select and lock jobs
   */
  async pickJobs(limit: number): Promise<JobData[]> {
    // Use a transaction to ensure atomicity
    return await this.drizzleConnection.transaction(async (tx) => {
      // Select and lock jobs
      const jobs = await this.selectAndLockJobs(tx, limit);

      if (jobs.length === 0) {
        return [];
      }

      const jobDataArray: JobData[] = [];

      for (const job of jobs) {
        const jobData = {
          generalId: job["general_id"] as string,
          name: job["name"] as JobName,
          payload: (typeof job["payload"] === "string"
            ? JSON.parse(job["payload"])
            : job["payload"]) as Record<string, unknown>,
        };

        // Delete the job within the same transaction
        await this.deleteJob(tx, job["id"]);

        // Check if this is a scheduled job that needs to be rescheduled
        await this.rescheduleJobIfNeeded(tx, jobData);

        jobDataArray.push(jobData);
      }

      return jobDataArray;
    });
  }

  /**
   * Process jobs from the queue using a worker pool pattern
   */
  async processJobsWithPool(
    handler: JobHandler,
    workerId: number,
    numWorkers: number,
  ): Promise<void> {
    if (this.isBuildProcess()) {
      this.processing = false;
      return;
    }

    // Create a job queue to hold jobs waiting to be processed
    const jobQueue: JobData[] = [];
    let consecutiveEmptyPolls = 0;
    const baseSleepTime = 100; // 100ms base sleep time
    const batchSize = Math.max(5, numWorkers * 2); // Pull more jobs than workers to keep them busy
    const minQueueSize = Math.max(3, Math.floor(numWorkers / 2)); // Threshold to trigger new job fetching

    // Job producer - continuously fetches jobs to keep the queue filled
    const producer = async () => {
      while (this.processing && !this.maintenanceState.isMaintenanceMode) {
        try {
          // Only fetch more jobs if queue is getting low
          if (jobQueue.length <= minQueueSize) {
            const jobs = await this.pickJobs(batchSize);
            if (jobs.length > 0) {
              jobQueue.push(...jobs);
              consecutiveEmptyPolls = 0;
            } else {
              consecutiveEmptyPolls++;
              // Use exponential backoff when no jobs are found
              const sleepTime = Math.min(
                baseSleepTime * 1.5 ** consecutiveEmptyPolls,
                5000,
              );
              await Bun.sleep(sleepTime);
            }
          } else {
            // Small sleep when queue is sufficiently filled
            await Bun.sleep(100);
          }
        } catch (error) {
          logError(`Error fetching jobs for worker ${workerId}:`, error);
          consecutiveEmptyPolls++;
          await Bun.sleep(1000); // Sleep on error to prevent rapid retries
        }
      }
    };

    // Create worker pool - consumers that process jobs from the queue
    const consumers = Array.from(
      { length: numWorkers },
      async (_, workerIndex) => {
        while (this.processing) {
          const jobData = jobQueue.shift();
          if (!jobData) {
            await Bun.sleep(50); // Small sleep when no jobs available
            continue;
          }

          try {
            await handler(jobData);
          } catch (error) {
            logError(
              `Error processing job in worker ${workerId}.${workerIndex}:`,
              error,
            );
          }
        }
      },
    );

    // Run producer and consumers concurrently
    await Promise.all([producer(), ...consumers]);
  }

  /**
   * Start processing jobs with the specified handler
   */
  startProcessing(handler: JobHandler, numWorkers = 1): void {
    // If we're in a build process, don't start processing
    if (this.isBuildProcess()) {
      return;
    }

    this.processing = true;

    // Start a single worker that manages a pool of subworkers
    this.processJobsWithPool(handler, 0, numWorkers).catch((error: unknown) =>
      logError("Worker pool error:", error),
    );
  }

  /**
   * Stop processing jobs
   */
  stopProcessing(): void {
    this.processing = false;
  }
}

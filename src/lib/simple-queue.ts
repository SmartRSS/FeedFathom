import { type } from "arktype";
import type { RedisClient } from "bun";
import { llog, logError } from "../util/log.ts";

// Define the JobData validator
const jobDataValidator = type({
  "generalId?": "string",
  "instanceId?": "string",
  "name?": "string",
  "delay?": "number",
  "payload?": "object",
  "every?": "number.integer",
  "+": "reject",
});

// Define a specific validator for scheduled jobs
const scheduledJobValidator = jobDataValidator.and({
  every: "number.integer",
});

// Infer the JobData type from the validator
type JobData = typeof jobDataValidator.infer;

type JobHandler = (
  jobData: JobData,
  //   queueInstance: SimpleQueue,
) => Promise<void> | void;

interface ScheduleJobOptions {
  id: string;
  name: string;
  every: number;
  payload?: Record<string, unknown>;
}

interface ScheduleRepeatOptions {
  generalId: string;
  every: number;
  payload?: Record<string, unknown>;
  lastRun: number;
}

export class SimpleQueue {
  private immediateQueueKey = "immediate_fifo_queue";
  private scheduledJobIdsKey = "scheduled_general_ids";
  private jobReferenceCountersKey = "job_reference_counters";
  private processing = false;

  constructor(private readonly redis: RedisClient) {}

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
   * Add a job to the immediate queue
   */
  async addJobToQueue(jobData: JobData): Promise<void> {
    // If we're in a build process, don't add jobs
    if (this.isBuildProcess()) {
      llog("Build process detected, skipping job add");
      return;
    }

    // Ensure delay is set (default to 0 if not provided)
    const jobWithDefaults = {
      ...jobData,
      delay: (jobData.delay ?? 0) * 1000 + Date.now(),
    };
    llog("Job with defaults:", jobWithDefaults);

    try {
      // Check if this is a duplicate job
      const isDuplicate = await this.withTimeout(
        () => this.isDuplicateJob(jobWithDefaults),
        "isDuplicateJob",
      );

      if (isDuplicate) {
        return;
      }

      // Increment the reference counter for this job
      await this.withTimeout(
        () => this.incrementJobReference(jobWithDefaults),
        "incrementJobReference",
      );

      // Add to queue
      await this.withTimeout(
        () =>
          this.redis.lpush(
            this.immediateQueueKey,
            JSON.stringify(jobWithDefaults),
          ),
        "lpush",
      );
    } catch (error) {
      logError("Error adding job to queue:", error);
    }
  }

  /**
   * Check if a job is a duplicate
   */
  private async isDuplicateJob(jobData: JobData): Promise<boolean> {
    try {
      // Check if the queue is empty
      const queueLength = await this.redis.llen(this.immediateQueueKey);

      // If queue is empty, clear all reference counters
      if (queueLength === 0) {
        await this.clearAllReferenceCounters();
        return false; // Not a duplicate if we've cleared all counters
      }

      // For jobs with generalId, check the reference counter
      if (jobData.generalId) {
        const counter = await this.redis.get(
          `${this.jobReferenceCountersKey}:${jobData.generalId}`,
        );
        // If counter exists and is greater than 0, it's a duplicate
        return counter !== null && Number.parseInt(counter, 10) > 0;
      }

      // For jobs without generalId, we can't reliably check for duplicates
      return false;
    } catch (error) {
      logError("Error checking for duplicate job:", error);
      // If we can't check, assume it's not a duplicate
      return false;
    }
  }

  /**
   * Increment the reference counter for a job
   */
  private async incrementJobReference(jobData: JobData): Promise<void> {
    try {
      if (jobData.generalId) {
        const key = `${this.jobReferenceCountersKey}:${jobData.generalId}`;
        const currentValue = await this.redis.get(key);
        const newValue = currentValue
          ? Number.parseInt(currentValue, 10) + 1
          : 1;
        await this.redis.set(key, newValue.toString());
      }
    } catch (error) {
      logError("Error incrementing job reference:", error);
    }
  }

  /**
   * Decrement the reference counter for a job
   */
  private async decrementJobReference(jobData: JobData): Promise<void> {
    try {
      if (jobData.generalId) {
        const key = `${this.jobReferenceCountersKey}:${jobData.generalId}`;
        const currentValue = await this.redis.get(key);
        if (currentValue) {
          const newValue = Math.max(0, Number.parseInt(currentValue, 10) - 1);
          await this.redis.set(key, newValue.toString());
        }
      }
    } catch (error) {
      logError("Error decrementing job reference:", error);
    }
  }

  /**
   * Clear all job reference counters
   */
  private async clearAllReferenceCounters(): Promise<void> {
    try {
      // Get all keys with the reference counter prefix
      const pattern = `${this.jobReferenceCountersKey}:*`;
      const keys = await this.redis.keys(pattern);

      if (keys.length > 0) {
        // Delete each key individually
        for (const key of keys) {
          await this.redis.del(key);
        }
      }
    } catch (error) {
      logError("Error clearing job reference counters:", error);
    }
  }

  /**
   * Schedule a job to run at regular intervals
   */
  async scheduleJob(options: ScheduleJobOptions): Promise<void> {
    const { id: generalId, name, every, payload = {} } = options;

    try {
      // Check if this job is already in the queue or being processed
      const isDuplicate = await this.isDuplicateJob({ generalId });
      if (isDuplicate) {
        return;
      }

      // Add to scheduled jobs set
      await this.redis.sadd(this.scheduledJobIdsKey, generalId);

      if (Number.isNaN(every) || every <= 0) {
        logError(
          `Invalid 'every' value for scheduled job ${generalId}: ${every}`,
        );
        return;
      }

      const firstInstanceId = `${generalId}:0`;

      // Increment the reference counter for this job
      await this.incrementJobReference({ generalId });

      await this.addJobToQueue({
        generalId,
        instanceId: firstInstanceId,
        name,
        delay: 0,
        payload,
        every, // Include the interval for repeating jobs
      });
    } catch (error) {
      logError("Error scheduling job:", error);
      // Continue with adding the job even if scheduling fails
      const firstInstanceId = `${generalId}:0`;
      await this.addJobToQueue({
        generalId,
        instanceId: firstInstanceId,
        name,
        delay: 0,
        payload,
        every,
      });
    }
  }

  /**
   * Schedule the next repeat of a job
   */
  async scheduleNextRepeat(options: ScheduleRepeatOptions): Promise<void> {
    const { generalId, every, payload = {}, lastRun } = options;

    if (Number.isNaN(every) || every <= 0) {
      logError(`Invalid 'every' value for repeat job ${generalId}: ${every}`);
      return;
    }

    // Calculate next run time
    const delay = every * 1000;
    const nextInstanceId = `${generalId}:${delay + lastRun}`;

    // Increment the reference counter for this job
    await this.incrementJobReference({ generalId });

    await this.addJobToQueue({
      generalId,
      instanceId: nextInstanceId,
      delay,
      payload,
      every,
    });
  }

  /**
   * Execute a Redis operation with a timeout
   */
  private async withTimeout<T>(
    operation: () => Promise<T>,
    operationName: string,
    timeoutMs = 5000,
  ): Promise<T | null> {
    try {
      // Create a promise that rejects after the timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `Redis operation '${operationName}' timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      });

      // Race the operation against the timeout
      return await Promise.race([operation(), timeoutPromise]);
    } catch (error) {
      logError(`Error in Redis operation '${operationName}':`, error);
      return null;
    }
  }

  /**
   * Process jobs from the queue
   */
  async processJob(handler: JobHandler): Promise<void> {
    // If we're in a build process, don't start processing
    if (this.isBuildProcess()) {
      llog("Build process detected, skipping queue processing");
      this.processing = false;
      return;
    }

    while (this.processing) {
      try {
        // Get current queue length
        const queueLength = await this.withTimeout(
          () => this.redis.llen(this.immediateQueueKey),
          "llen",
        );

        // If queue is empty, clear all reference counters
        if (queueLength === 0) {
          await this.clearAllReferenceCounters();
        }

        // Get a job from the queue with timeout
        const result = await this.withTimeout(
          () => this.redis.rpop(this.immediateQueueKey),
          "rpop",
        );

        if (!result) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        // Process the job
        await this.processSingleJob(result, handler);
      } catch (error) {
        // Log the error and wait before retrying
        logError("Error in processJob:", error);
        llog("Error occurred, waiting before retry");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Process a single job from the queue
   */
  private async processSingleJob(
    jobString: string,
    handler: JobHandler,
  ): Promise<void> {
    // Parse and validate job data
    let jobData: JobData;
    try {
      const parsedData = JSON.parse(jobString) as Record<string, unknown>;

      // Use the appropriate validator based on whether this is a scheduled job
      const validationResult = parsedData["every"]
        ? scheduledJobValidator(parsedData)
        : jobDataValidator(parsedData);

      if (validationResult instanceof type.errors) {
        logError("Invalid job data format:", validationResult.summary);
        return;
      }

      jobData = validationResult as JobData;
    } catch (error) {
      logError("Error parsing job data:", error);
      return;
    }

    // Decrement the reference counter at the start of processing
    await this.decrementJobReference(jobData);

    const now = Date.now();

    // Check if job is ready to run
    if (jobData.delay && now < jobData.delay) {
      // Job is not ready yet, put it back in the queue
      llog("Job is not ready yet, putting it back in the queue");
      await this.addJobToQueue(jobData);
      return;
    }

    try {
      if (jobData.every && jobData.generalId) {
        llog("Scheduling next repeat");
        await this.scheduleNextRepeat({
          generalId: jobData.generalId,
          every: jobData.every,
          payload: (jobData.payload as Record<string, unknown>) || {},
          lastRun: now,
        });
      }

      // Execute the job handler
      if (handler && typeof handler === "function") {
        await handler(jobData);
      }
    } catch (error) {
      // Log the error but don't rethrow it to prevent the worker from crashing
      logError("Error processing job:", error);
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
      this.processJob(handler).catch((error) =>
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

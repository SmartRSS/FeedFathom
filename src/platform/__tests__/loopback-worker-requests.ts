import type { QueueEvents } from "bullmq";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { type WorkerJobHandlers, WorkerJobs } from "#platform/worker-jobs.ts";
import {
  answerWorkerRequest,
  type WorkerRequestCancels,
  type WorkerRequestHandlers,
  WorkerRequests,
} from "#platform/worker-requests.ts";

const overRedis = (value: unknown): unknown => {
  const stored = JSON.stringify(value);
  return JSON.parse(stored);
};

const unusedCancels = strictFake<WorkerRequestCancels>({}, "cancels");

export const loopbackWorkerRequests = (handlers: () => WorkerRequestHandlers) =>
  new WorkerRequests(
    {
      add: async (name, data) => ({
        waitUntilFinished: async () =>
          overRedis(
            await answerWorkerRequest(
              { data: overRedis(data), name, timestamp: Date.now() },
              handlers(),
            ),
          ),
      }),
    },
    () => strictFake<QueueEvents>({}, "queueEvents"),
    unusedCancels,
  );

export const unansweredWorkerRequests = (timeoutMs = 20) =>
  new WorkerRequests(
    {
      add: async () => ({
        waitUntilFinished: async () => new Promise<never>(() => {}),
      }),
    },
    () => strictFake<QueueEvents>({}, "queueEvents"),
    unusedCancels,
    timeoutMs,
  );

export const loopbackWorkerJobs = (handlers: () => WorkerJobHandlers) =>
  new WorkerJobs({
    add: async (name, data) => {
      const handler = handlers().get(name);
      if (!handler) throw new Error(`Unknown worker job ${name}`);
      await handler(overRedis(data));
    },
  });

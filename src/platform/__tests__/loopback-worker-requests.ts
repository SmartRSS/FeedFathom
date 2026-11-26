import type { QueueEvents } from "bullmq";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import {
  answerWorkerRequest,
  type WorkerRequestHandlers,
  WorkerRequests,
} from "#platform/worker-requests.ts";

const overRedis = (value: unknown): unknown => {
  const stored = JSON.stringify(value);
  return JSON.parse(stored);
};

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
  );

export const unansweredWorkerRequests = (timeoutMs = 20) =>
  new WorkerRequests(
    {
      add: async () => ({
        waitUntilFinished: async () => new Promise<never>(() => {}),
      }),
    },
    () => strictFake<QueueEvents>({}, "queueEvents"),
    timeoutMs,
  );

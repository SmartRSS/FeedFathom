import { Worker } from "bullmq";
import { config } from "#platform/config.ts";
import {
  bullmqQueue,
  bullmqRedis,
  close,
  createSubscriber,
  drizzleConnection,
  jobQueueName,
} from "#platform/runtime.ts";
import {
  listenForWorkerRequestCancels,
  workerRequestQueueName,
} from "#platform/worker-requests.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import { containerPort } from "#platform/http/internal-routes.ts";
import {
  faviconRefresher,
  feedParser,
  feedRequestHandlers,
  retentionService,
  sourceEnqueuer,
  sourceJobHandlers,
  sourcesDataService,
  webSubSubscriber,
} from "#features/feeds/services.ts";
import { mailRequestHandlers } from "#features/mail-ingest/services.ts";
import { MainWorker } from "#features/jobs/main.ts";
import { runWorker } from "./worker-app.ts";

let requestWorker: Worker | undefined;
const cancelSubscriber = createSubscriber();
await listenForWorkerRequestCancels(cancelSubscriber, (jobId) => {
  requestWorker?.cancelJob(jobId);
});

await runWorker({
  close: async () => {
    cancelSubscriber.disconnect();
    await close();
  },
  mainWorker: new MainWorker({
    bullmqQueue,
    config,
    createRequestWorker: (processor, options) => {
      requestWorker = new Worker(workerRequestQueueName, processor, {
        ...options,
        connection: bullmqRedis,
      });
      return requestWorker;
    },
    createWorker: (processor, options) =>
      new Worker(jobQueueName, processor, {
        ...options,
        connection: bullmqRedis,
      }),
    faviconRefresher,
    feedParser,
    jobHandlers: new Map(sourceJobHandlers),
    requestHandlers: new Map([...feedRequestHandlers, ...mailRequestHandlers]),
    retentionService,
    sourceEnqueuer,
    sourcesDataService,
    webSubSubscriber,
  }),
  port: containerPort,
  waitForMigration: () => waitForMigration(drizzleConnection.$client),
}).ready;

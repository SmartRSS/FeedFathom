import { Worker } from "bullmq";
import { config } from "#platform/config.ts";
import {
  bullmqQueue,
  bullmqRedis,
  close,
  drizzleConnection,
  jobQueueName,
} from "#platform/runtime.ts";
import { workerRequestQueueName } from "#platform/worker-requests.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import { containerPort } from "#platform/http/internal-routes.ts";
import {
  faviconRefresher,
  feedParser,
  feedRequestHandlers,
  retentionService,
  sourceEnqueuer,
  sourcesDataService,
  webSubSubscriber,
} from "#features/feeds/services.ts";
import { mailRequestHandlers } from "#features/mail-ingest/services.ts";
import { MainWorker } from "#features/jobs/main.ts";
import { runWorker } from "./worker-app.ts";

await runWorker({
  close,
  mainWorker: new MainWorker({
    bullmqQueue,
    config,
    createRequestWorker: (processor, options) =>
      new Worker(workerRequestQueueName, processor, {
        ...options,
        connection: bullmqRedis,
      }),
    createWorker: (processor, options) =>
      new Worker(jobQueueName, processor, {
        ...options,
        connection: bullmqRedis,
      }),
    faviconRefresher,
    feedParser,
    requestHandlers: new Map([...feedRequestHandlers, ...mailRequestHandlers]),
    retentionService,
    sourceEnqueuer,
    sourcesDataService,
    webSubSubscriber,
  }),
  port: containerPort,
  waitForMigration: () => waitForMigration(drizzleConnection.$client),
}).ready;

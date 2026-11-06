import { Worker } from "bullmq";
import { config } from "#platform/config.ts";
import {
  bullmqQueue,
  bullmqRedis,
  close,
  drizzleConnection,
  jobQueueName,
} from "#platform/runtime.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import { containerPort } from "#platform/http/internal-routes.ts";
import {
  faviconRefresher,
  feedParser,
  retentionService,
  sourceEnqueuer,
  sourcesDataService,
  webSubSubscriber,
} from "#features/feeds/services.ts";
import { MainWorker } from "#features/jobs/main.ts";
import { runWorker } from "./worker-app.ts";

await runWorker({
  close,
  mainWorker: new MainWorker({
    bullmqQueue,
    config,
    createWorker: (processor, options) =>
      new Worker(jobQueueName, processor, {
        ...options,
        connection: bullmqRedis,
      }),
    faviconRefresher,
    feedParser,
    retentionService,
    sourceEnqueuer,
    sourcesDataService,
    webSubSubscriber,
  }),
  port: containerPort,
  waitForMigration: () => waitForMigration(drizzleConnection.$client),
}).ready;

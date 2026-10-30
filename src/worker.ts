import { Worker } from "bullmq";
import { config } from "#platform/config.ts";
import {
  bullmqQueue,
  bullmqRedis,
  close,
  drizzleConnection,
  httpClient,
} from "#platform/runtime.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import {
  feedParser,
  sourceEnqueuer,
  sourcesDataService,
  userSourcesDataService,
  websubStateService,
} from "#features/feeds/services.ts";
import { cleanupOrphanedData } from "#features/feeds/retention.ts";
import { faviconRefresher } from "#features/jobs/services.ts";
import { MainWorker } from "#features/jobs/main.ts";
import { runWorker } from "./worker-app.ts";

await runWorker({
  close,
  mainWorker: new MainWorker({
    bullmqQueue,
    cleanupOrphanedData: (...days) =>
      cleanupOrphanedData(drizzleConnection, ...days),
    config,
    createWorker: (processor, options) =>
      new Worker("tasks", processor, { ...options, connection: bullmqRedis }),
    faviconRefresher,
    feedParser,
    hubPoster: httpClient,
    sourceEnqueuer,
    sourcesDataService,
    userSourcesDataService,
    websubStateService,
  }),
  waitForMigration: () => waitForMigration(drizzleConnection.$client),
});

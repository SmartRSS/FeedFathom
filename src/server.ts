import {
  close,
  drizzleConnection,
  fetcher,
  httpClient,
  password,
} from "#platform/runtime.ts";
import { config } from "#platform/config.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import {
  authThrottle,
  mailSender,
  outboundFetchBudget,
  usersDataService,
} from "#features/auth/services.ts";
import {
  articleImporter,
  articlesDataService,
  feedParser,
  feedPreviewCache,
  foldersDataService,
  opmlImportService,
  redirectMap,
  sourceEnqueuer,
  sourcesDataService,
  userSourcesDataService,
  websubStateService,
} from "#features/feeds/services.ts";
import { emailHandler } from "#features/mail-ingest/services.ts";
import { articleEventHub } from "#features/reader/services.ts";
import { createServerApp } from "./server-app.ts";

const production = Bun.env.NODE_ENV === "production";
export const app = await createServerApp(
  {
    articleEventHub,
    articleImporter,
    articlesDataService,
    authThrottle,
    config,
    emailHandler,
    feedParser,
    feedPreviewCache,
    fetcher,
    foldersDataService,
    httpClient,
    mailSender,
    opmlImportService,
    outboundFetchBudget,
    password,
    redirectMap,
    sourceEnqueuer,
    sourcesDataService,
    userSourcesDataService,
    usersDataService,
    websubStateService,
  },
  { production },
);

// Wait for the required migration before listening so requests cannot reach
// a schema the server was not built for.
await waitForMigration(drizzleConnection.$client);

app.listen(config.PORT ?? 3000);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => {
  // First: graceful stop waits for open responses, and event streams never
  // finish on their own.
  articleEventHub.close();
  return (shutdownPromise ??= Promise.resolve(app.stop())
    .then(() => close())
    .then(() => undefined));
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

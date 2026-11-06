import {
  close,
  drizzleConnection,
  fetcher,
  httpClient,
  password,
} from "#platform/runtime.ts";
import { config } from "#platform/config.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import { containerPort } from "#platform/http/internal-routes.ts";
import * as auth from "#features/auth/services.ts";
import * as feeds from "#features/feeds/services.ts";
import * as mailIngest from "#features/mail-ingest/services.ts";
import * as reader from "#features/reader/services.ts";
import { createServerApp, stopServerApp } from "./server-app.ts";

// Spreading a module keeps all of its services in the bundle, including the
// worker-only faviconRefresher and retentionService that no route reaches.
// Their constructors only store their arguments, so they cost code size alone.
const services = {
  ...auth,
  ...feeds,
  ...mailIngest,
  ...reader,
  config,
  fetcher,
  httpClient,
  password,
};
export const app = await createServerApp(services);

// Wait for the required migration before listening so requests cannot reach
// a schema the server was not built for.
await waitForMigration(drizzleConnection.$client);

app.listen(config.PORT ?? containerPort);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () =>
  (shutdownPromise ??= stopServerApp(app, services).then(() => close()));
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

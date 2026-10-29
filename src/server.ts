import {
  close,
  drizzleConnection,
  fetcher,
  httpClient,
  password,
} from "#platform/runtime.ts";
import { config } from "#platform/config.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import * as auth from "#features/auth/services.ts";
import * as feeds from "#features/feeds/services.ts";
import * as mailIngest from "#features/mail-ingest/services.ts";
import * as reader from "#features/reader/services.ts";
import { createServerApp } from "./server-app.ts";

const production = Bun.env.NODE_ENV === "production";
// The server uses every service these four modules build, so spreading them
// pulls in nothing the bundle would otherwise drop.
export const app = await createServerApp(
  {
    ...auth,
    ...feeds,
    ...mailIngest,
    ...reader,
    config,
    fetcher,
    httpClient,
    password,
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
  reader.articleEventHub.close();
  return (shutdownPromise ??= Promise.resolve(app.stop())
    .then(() => close())
    .then(() => undefined));
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

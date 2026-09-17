import { close, drizzleConnection } from "#platform/runtime.ts";
import { config } from "#platform/config.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import { createServerApp } from "./server-app.ts";

const production = Bun.env.NODE_ENV === "production";
export const app = await createServerApp({ production });

// Wait for the required migration before listening so requests cannot reach
// a schema the server was not built for.
await waitForMigration(drizzleConnection.$client);

app.listen(config.PORT ?? 3000);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () =>
  (shutdownPromise ??= Promise.resolve(app.stop())
    .then(() => close())
    .then(() => undefined));
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

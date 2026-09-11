import { close, drizzleConnection } from "#platform/runtime.ts";
import { config } from "#platform/config.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import { createServerApp } from "./server-app.ts";

const production = Bun.env.NODE_ENV === "production";
export const app = await createServerApp({ production });

// Unlike the worker, which reports healthy while it waits because nothing
// routes to it, the server must not accept traffic against a schema it was
// not built for -- that would answer requests with errors instead of making
// the orchestrator wait. So it does not listen at all until its migration is
// applied, and the healthcheck's start_period is what covers that gap. A
// migration slower than that budget leaves the server restarting until it
// finishes, which is noisy but self-correcting.
await waitForMigration(drizzleConnection.$client);

app.listen(config.PORT ?? 3000);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () =>
  (shutdownPromise ??= Promise.resolve(app.stop())
    .then(() => close())
    .then(() => undefined));
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

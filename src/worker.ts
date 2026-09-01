import { Worker } from "bullmq";
import { isLoopbackAddress } from "#shared/net/private-network-guard.ts";
import { config } from "#platform/config.ts";
import { waitForMigration } from "#platform/db/connection.ts";
import { MainWorker, type MainWorkerFactory } from "#features/jobs/main.ts";
import { createFeedRuntime } from "./runtime.ts";

async function runWorker() {
  const runtime = await createFeedRuntime();
  const createWorker: MainWorkerFactory = (processor, options) => {
    const worker = new Worker("tasks", processor, {
      ...options,
      connection: runtime.bullmqRedis,
    });
    return {
      close: () => worker.close(),
      onFailed: (listener) => {
        worker.on("failed", listener);
      },
    };
  };
  const mainWorker = new MainWorker(
    config,
    runtime.bullmqQueue,
    runtime.feedParser,
    runtime.faviconRefresher,
    runtime.sourcesDataService,
    runtime.cleanupOrphanedData,
    runtime.jobFailuresDataService,
    createWorker,
  );
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      try {
        await mainWorker.cleanup();
        await runtime.close();
        console.log("Worker closed gracefully");
        process.exit(0);
      } catch (error) {
        console.error("Failed to close worker gracefully:", error);
        process.exit(1);
      }
    })();
    return shutdownPromise;
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });

  let migrationApplied = false;

  // The port opens before the migration wait so a probe gets a definitive
  // answer rather than a refused connection -- but the answer is 503 until
  // the schema this build was compiled against is actually present. A worker
  // that cannot touch the database is not ready to be rolled onto, and
  // reporting "ok" there let `up --wait` and Swarm's rollout monitor call a
  // deployment finished against workers that could not do any work yet.
  //
  // The healthcheck's start_period is what keeps that not-ready window from
  // reading as a crash loop, so it has to cover a normal migration; see the
  // budget and its consequences in compose.yml. A migration too slow for
  // that budget is rolled out by hand.
  Bun.serve({
    async fetch(request, server) {
      const url = new URL(request.url);
      const ip = server.requestIP(request)?.address ?? "";

      if (!isLoopbackAddress(ip)) {
        return Response.json({ error: "Unauthorized" }, { status: 403 });
      }

      if (url.pathname === "/healthcheck") {
        return migrationApplied
          ? Response.json({ status: "ok" })
          : Response.json({ status: "migrating" }, { status: 503 });
      }

      return new Response("Not Found", { status: 404 });
    },
    port: 3000,
  });

  await waitForMigration(runtime.drizzleConnection.$client);
  migrationApplied = true;

  try {
    await mainWorker.initialize();
  } catch (error) {
    console.error("Failed to initialize worker:", error);
    throw new Error("Worker initialization failed", { cause: error });
  }
}

await runWorker();

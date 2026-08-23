import { Value } from "typebox/value";
import { Worker } from "bullmq";
import { internalAddressPolicy } from "#shared/validation/typebox-policy.ts";
import { config } from "#platform/config.ts";
import { MainWorker, type MainWorkerFactory } from "./lib/workers/main.ts";
import { waitForMigration } from "./db/connection.ts";
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

  // Served before the worker starts consuming, so a worker still waiting on
  // the migrator reports what it is -- alive and idle -- instead of looking
  // like a crash loop to Compose's --wait and to Swarm's rollout monitor.
  Bun.serve({
    async fetch(request, server) {
      const url = new URL(request.url);
      const ip = server.requestIP(request)?.address ?? "";

      if (!Value.Check(internalAddressPolicy, ip)) {
        return Response.json({ error: "Unauthorized" }, { status: 403 });
      }

      if (url.pathname === "/healthcheck") {
        return Response.json({ status: "ok" });
      }

      return new Response("Not Found", { status: 404 });
    },
    port: 3000,
  });

  await waitForMigration(runtime.drizzleConnection.$client);

  try {
    await mainWorker.initialize();
  } catch (error) {
    console.error("Failed to initialize worker:", error);
    throw new Error("Worker initialization failed", { cause: error });
  }
}

await runWorker();

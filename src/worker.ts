import { Value } from "typebox/value";
import { Worker } from "bullmq";
import { config } from "./config.ts";
import { internalAddressPolicy } from "./lib/typebox-policy.ts";
import { MainWorker, type MainWorkerFactory } from "./lib/workers/main.ts";
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
    runtime.userSourcesDataService,
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

  try {
    await mainWorker.initialize();
  } catch (error) {
    console.error("Failed to initialize worker:", error);
    throw new Error("Worker initialization failed", { cause: error });
  }

  Bun.serve({
    port: 3000,
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
  });
}

await runWorker();

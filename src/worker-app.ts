import type { MainWorker } from "#features/jobs/main.ts";
import {
  healthcheckPath,
  healthcheckResponse,
} from "#platform/http/internal-routes.ts";

export type WorkerAppServices = {
  close: () => Promise<void>;
  mainWorker: MainWorker;
  port: number;
  waitForMigration: () => Promise<void>;
};

export function runWorker({
  close,
  mainWorker,
  port,
  waitForMigration,
}: WorkerAppServices) {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      try {
        await mainWorker.cleanup();
        await close();
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

  let consuming = false;

  const healthcheckServer = Bun.serve({
    fetch(request, server) {
      if (new URL(request.url).pathname !== healthcheckPath)
        return new Response("Not Found", { status: 404 });
      return healthcheckResponse(
        server.requestIP(request)?.address ?? "",
        consuming,
      );
    },
    port,
  });

  const ready = (async () => {
    await waitForMigration();
    try {
      await mainWorker.initialize();
    } catch (error) {
      console.error("Failed to initialize worker:", error);
      throw new Error("Worker initialization failed", { cause: error });
    }
    consuming = true;
  })();
  return { ready, server: healthcheckServer };
}

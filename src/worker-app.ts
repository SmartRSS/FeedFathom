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

// Returns the healthcheck server at once and `ready` when jobs are consumed.
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

  // The port opens before startup finishes so a probe gets a definitive
  // answer rather than a refused connection -- but the answer is 503 until
  // the BullMQ worker is consuming jobs. That needs the schema this build was
  // compiled against and a reachable Redis. Reporting "ok" any earlier let
  // `up --wait` and Swarm's start-first rollout stop the old workers in
  // favour of new ones still blocked on startup, and feed polling stopped
  // with every check green.
  //
  // The healthcheck's start_period is what keeps that not-ready window from
  // reading as a crash loop, so it has to cover a normal migration; see the
  // budget and its consequences in compose.yml. A migration too slow for
  // that budget is rolled out by hand.
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

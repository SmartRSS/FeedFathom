import { asValue } from "awilix";
import container from "./container.ts";
import { logError } from "./util/log.ts";

// Create a simple HTTP server for health checks
Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // Handle healthcheck requests
    if (url.pathname === "/healthcheck") {
      const isMaintenanceMode = container.resolve("isMaintenanceMode");

      if (isMaintenanceMode) {
        return new Response(
          JSON.stringify({ status: "down for maintenance" }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle maintenance mode toggle
    if (url.pathname === "/maintenance" && req.method === "POST") {
      try {
        const body = (await req.json()) as { maintenance?: boolean };
        const newState = body.maintenance === true;

        // Update the maintenance mode state
        container.register({
          isMaintenanceMode: asValue(newState),
        });

        return new Response(
          JSON.stringify({
            status: "success",
            maintenance: newState,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        logError("Failed to update maintenance mode:", error);
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Invalid request body",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // Return 404 for all other paths
    return new Response("Not Found", { status: 404 });
  },
});

try {
  const initializer = container.resolve("initializer");
  await initializer.initialize();
} catch (error) {
  logError("Failed to initialize worker:", error);
  throw new Error("Worker initialization failed");
}

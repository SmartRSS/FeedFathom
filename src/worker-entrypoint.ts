import container from "./container.ts";
import { logError } from "./util/log.ts";
import { isInternalRequest } from "./util/security.ts";

// Create a simple HTTP server for health checks
Bun.serve({
  port: 3000,
  fetch(req, server) {
    const url = new URL(req.url);
    const ip = server.requestIP(req)?.address ?? "";

    // Reject all non-internal requests early
    if (
      !isInternalRequest({
        headers: req.headers,
        address: ip,
      })
    ) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle healthcheck requests
    if (url.pathname === "/healthcheck") {
      if (container.cradle.maintenanceState.isMaintenanceMode) {
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
        container.cradle.maintenanceState.isMaintenanceMode = true;
        return new Response(
          JSON.stringify({
            status: "success",
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

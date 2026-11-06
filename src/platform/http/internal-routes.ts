import { Elysia } from "elysia";
import { isLoopbackAddress } from "#shared/net/private-network-guard.ts";

// The port both processes listen on inside their container. compose.yml's
// healthcheck probes it as a literal.
export const containerPort = 3000;
export const healthcheckPath = "/healthcheck";

// Loopback only: the probe runs inside the container, and nobody outside
// needs to learn whether this process is up.
export function healthcheckResponse(address: string, ready: boolean) {
  if (!isLoopbackAddress(address))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!ready) return Response.json({ status: "starting" }, { status: 503 });
  return Response.json({ status: "ok" });
}

// The server only listens once its schema is in place, so it is always ready.
export const createInternalRoutes = () =>
  new Elysia().get(healthcheckPath, ({ request, server }) =>
    healthcheckResponse(server?.requestIP(request)?.address ?? "", true),
  );

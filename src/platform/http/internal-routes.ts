import { Elysia } from "elysia";
import { jsonError } from "./json.ts";

// The healthcheck answers only when the request came from this machine. Exact literals
// rather than a range check -- the peer address is one of these three or the
// request is not local.
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const isLoopbackAddress = (address: string): boolean =>
  loopbackAddresses.has(address);

// The port both processes listen on inside their container. compose.yml's
// healthcheck probes it as a literal.
export const containerPort = 3000;
export const healthcheckPath = "/healthcheck";

// Loopback only: the probe runs inside the container, and nobody outside
// needs to learn whether this process is up.
export function healthcheckResponse(address: string, ready: boolean) {
  if (!isLoopbackAddress(address)) return jsonError("Forbidden", 403);
  if (!ready) return Response.json({ status: "starting" }, { status: 503 });
  return Response.json({ status: "ok" });
}

// The server only listens once its schema is in place, so it is always ready.
export const createInternalRoutes = () =>
  new Elysia().get(healthcheckPath, ({ request, server }) =>
    healthcheckResponse(server?.requestIP(request)?.address ?? "", true),
  );

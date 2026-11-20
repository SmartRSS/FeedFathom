import { Elysia } from "elysia";
import { jsonError } from "./json.ts";

const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const isLoopbackAddress = (address: string): boolean =>
  loopbackAddresses.has(address);

export const containerPort = 3000;
export const healthcheckPath = "/healthcheck";

export function healthcheckResponse(address: string, ready: boolean) {
  if (!isLoopbackAddress(address)) return jsonError("Forbidden", 403);
  if (!ready) return Response.json({ status: "starting" }, { status: 503 });
  return Response.json({ status: "ok" });
}

export const createInternalRoutes = () =>
  new Elysia().get(healthcheckPath, ({ request, server }) =>
    healthcheckResponse(server?.requestIP(request)?.address ?? "", true),
  );

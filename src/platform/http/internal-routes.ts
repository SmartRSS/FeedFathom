import { Elysia } from "elysia";
import { isLoopbackAddress } from "#shared/net/private-network-guard.ts";
import { json } from "#platform/http/json.ts";

export const healthcheckPath = "/healthcheck";

export const createInternalRoutes = () =>
  new Elysia().get(healthcheckPath, ({ request, server }) => {
    if (!isLoopbackAddress(server?.requestIP(request)?.address ?? ""))
      return json({ error: "Forbidden" }, 403);
    return json({ status: "ok" });
  });

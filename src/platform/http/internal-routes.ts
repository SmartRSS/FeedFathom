import { Elysia } from "elysia";
import { isLoopbackAddress } from "#shared/net/private-network-guard.ts";
import { json } from "#platform/http/json.ts";

export const createInternalRoutes = () =>
  new Elysia().get("/healthcheck", ({ request, server }) => {
    if (!isLoopbackAddress(server?.requestIP(request)?.address ?? ""))
      return json({ error: "Forbidden" }, 403);
    return json({ status: "ok" });
  });

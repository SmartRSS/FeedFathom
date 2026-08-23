import { Value } from "typebox/value";
import { Elysia } from "elysia";
import { internalAddressPolicy } from "#shared/validation/typebox-policy.ts";
import { json } from "#platform/http/json.ts";

export const createInternalRoutes = () =>
  new Elysia().get("/healthcheck", ({ request, server }) => {
    if (
      !Value.Check(
        internalAddressPolicy,
        server?.requestIP(request)?.address ?? "",
      )
    )
      return json({ error: "Forbidden" }, 403);
    return json({ status: "ok" });
  });

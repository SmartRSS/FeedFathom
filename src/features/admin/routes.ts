import { Elysia } from "elysia";
import {
  adminQuery,
  redirectDeletionRequest,
  removeSourceRequest,
  sourceUrlReplacementRequest,
} from "#shared/contracts/requests.ts";
import {
  adminSourcesResponse,
  redirectsResponse,
  removedIdResponse,
  successResponse,
} from "#shared/contracts/responses.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { createAdminPlugin } from "#features/auth/session-plugin.ts";
import type * as feeds from "#features/feeds/services.ts";

export type AdminRouteServices = Parameters<typeof createAdminPlugin>[0] &
  Pick<typeof feeds, "redirectMap" | "sourcesDataService">;

// Every route here sits behind createAdminPlugin, so the admin check is a
// property of the group instead of something each handler has to restate.
export const createAdminRoutes = (services: AdminRouteServices) => {
  const { redirectMap, sourcesDataService } = services;
  return new Elysia()
    .use(createAdminPlugin(services))
    .get("/api/admin", { query: adminQuery }, async ({ query }) =>
      json(
        adminSourcesResponse,
        await sourcesDataService.listAllSources(
          query.sortBy ?? "createdAt",
          query.order ?? "asc",
        ),
      ),
    )
    .post(
      "/api/admin",
      { body: sourceUrlReplacementRequest },
      async ({ body }) => {
        const result = await sourcesDataService.updateSourceUrl(
          body.oldUrl,
          body.newUrl,
        );
        if (result === "conflict")
          return jsonError("Source URL already exists", 409);
        if (result === "not-found")
          return jsonError("Source URL not found", 404);
        return json(successResponse, { success: true });
      },
    )
    .delete("/api/admin", { body: removeSourceRequest }, async ({ body }) => {
      await sourcesDataService.deleteSource(body.removeSourceId);
      return json(removedIdResponse, body.removeSourceId);
    })
    .get("/api/admin/redirects", async () =>
      json(redirectsResponse, await redirectMap.getAllRedirects()),
    )
    .delete(
      "/api/admin/redirects",
      { body: redirectDeletionRequest },
      async ({ body }) => {
        await redirectMap.removeRedirect(body.oldUrl);
        return json(successResponse, { success: true });
      },
    );
};

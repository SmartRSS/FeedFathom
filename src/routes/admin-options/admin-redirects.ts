import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { redirectDeletionRequest } from "../../contracts/requests.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import type { RedirectMap } from "../../lib/redirect-map.ts";
import { createAuthPlugin, json } from "../shared.ts";

export type AdminRedirectsRouteDependencies = {
  redirectMap: Pick<RedirectMap, "getAllRedirects" | "removeRedirect">;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createAdminRedirectsRoute({
  redirectMap,
  usersDataService,
}: AdminRedirectsRouteDependencies) {
  return new Elysia()
    .use(createAuthPlugin(usersDataService))
    .get("/api/admin/redirects", async ({ user }) =>
      user.isAdmin
        ? json(await redirectMap.getAllRedirects())
        : json({ error: "Unauthorized" }, 403),
    )
    .delete(
      "/api/admin/redirects",
      { body: redirectDeletionRequest },
      async ({ body, user }) => {
        if (!user.isAdmin) return json({ error: "Unauthorized" }, 403);
        const decoded = Value.Decode(redirectDeletionRequest, body);
        await redirectMap.removeRedirect(decoded.oldUrl);
        return json({ success: true });
      },
    );
}

import { Elysia } from "elysia";
import {
  adminQuery,
  passwordRequest,
  redirectDeletionRequest,
  removeSourceRequest,
  sourceUrlReplacementRequest,
} from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";
import {
  createAdminPlugin,
  createAuthPlugin,
} from "#features/auth/session-plugin.ts";
import {
  deleteAdminRedirectsHandler,
  getAdminRedirectsHandler,
} from "#features/admin/routes/admin-redirects.ts";
import {
  deleteAdminHandler,
  getAdminHandler,
  postAdminHandler,
} from "#features/admin/routes/admin.ts";
import {
  getOptionsOpmlHandler,
  opmlRequest,
  postOptionsOpmlHandler,
} from "#features/admin/routes/options-opml.ts";
import { postOptionsPasswordHandler } from "#features/admin/routes/options-password.ts";
import {
  currentSidFromCookie,
  deleteOptionsSessionHandler,
  deleteOtherSessionsHandler,
  getOptionsSessionsHandler,
} from "#features/admin/routes/options-sessions.ts";
import type * as runtime from "#platform/runtime.ts";
import type * as auth from "#features/auth/services.ts";
import type * as feeds from "#features/feeds/services.ts";

export type AdminRouteServices = Pick<typeof auth, "usersDataService"> &
  Pick<
    typeof feeds,
    | "foldersDataService"
    | "opmlImportService"
    | "redirectMap"
    | "sourcesDataService"
    | "userSourcesDataService"
  > &
  Pick<typeof runtime, "password">;

// Two groups rather than one, because /api/options is per-user and /api/admin
// is not. Splitting them is what lets the admin check be a property of the
// group instead of something each handler has to remember: a route added to
// the second instance cannot be reached without it.
const userOptionsRoutes = (services: AdminRouteServices) =>
  new Elysia()
    .use(createAuthPlugin(services))
    .get("/api/options", ({ user }) => json({ user }))
    .post("/api/options/password", { body: passwordRequest }, (ctx) =>
      postOptionsPasswordHandler(ctx, services),
    )
    .post("/api/options/opml", { body: opmlRequest }, (ctx) =>
      postOptionsOpmlHandler(ctx, services),
    )
    .get("/api/options/opml", (ctx) => getOptionsOpmlHandler(ctx, services))
    .get("/api/options/sessions", ({ user, cookie }) =>
      getOptionsSessionsHandler(user, currentSidFromCookie(cookie), services),
    )
    .delete("/api/options/sessions/:id", ({ user, params }) =>
      deleteOptionsSessionHandler(user, params, services),
    )
    .delete("/api/options/sessions", ({ user, cookie }) =>
      deleteOtherSessionsHandler(user, currentSidFromCookie(cookie), services),
    );

const adminOnlyRoutes = (services: AdminRouteServices) =>
  new Elysia()
    .use(createAdminPlugin(services))
    .get("/api/admin", { query: adminQuery }, (ctx) =>
      getAdminHandler(ctx, services),
    )
    .post("/api/admin", { body: sourceUrlReplacementRequest }, (ctx) =>
      postAdminHandler(ctx, services),
    )
    .delete("/api/admin", { body: removeSourceRequest }, (ctx) =>
      deleteAdminHandler(ctx, services),
    )
    .get("/api/admin/redirects", () => getAdminRedirectsHandler(services))
    .delete("/api/admin/redirects", { body: redirectDeletionRequest }, (ctx) =>
      deleteAdminRedirectsHandler(ctx, services),
    );

export const createAdminOptionsRoutes = (services: AdminRouteServices) =>
  new Elysia().use(userOptionsRoutes(services)).use(adminOnlyRoutes(services));

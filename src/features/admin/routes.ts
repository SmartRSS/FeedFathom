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

// Two groups rather than one, because /api/options is per-user and /api/admin
// is not. Splitting them is what lets the admin check be a property of the
// group instead of something each handler has to remember: a route added to
// the second instance cannot be reached without it.
const userOptionsRoutes = () =>
  new Elysia()
    .use(createAuthPlugin())
    .get("/api/options", ({ user }) => json({ user }))
    .post("/api/options/password", { body: passwordRequest }, (ctx) =>
      postOptionsPasswordHandler(ctx),
    )
    .post("/api/options/opml", { body: opmlRequest }, (ctx) =>
      postOptionsOpmlHandler(ctx),
    )
    .get("/api/options/opml", (ctx) => getOptionsOpmlHandler(ctx))
    .get("/api/options/sessions", ({ user, cookie }) =>
      getOptionsSessionsHandler(user, currentSidFromCookie(cookie)),
    )
    .delete("/api/options/sessions/:id", ({ user, params }) =>
      deleteOptionsSessionHandler(user, params),
    )
    .delete("/api/options/sessions", ({ user, cookie }) =>
      deleteOtherSessionsHandler(user, currentSidFromCookie(cookie)),
    );

const adminOnlyRoutes = () =>
  new Elysia()
    .use(createAdminPlugin())
    .get("/api/admin", { query: adminQuery }, (ctx) => getAdminHandler(ctx))
    .post("/api/admin", { body: sourceUrlReplacementRequest }, (ctx) =>
      postAdminHandler(ctx),
    )
    .delete("/api/admin", { body: removeSourceRequest }, (ctx) =>
      deleteAdminHandler(ctx),
    )
    .get("/api/admin/redirects", (ctx) => getAdminRedirectsHandler(ctx))
    .delete("/api/admin/redirects", { body: redirectDeletionRequest }, (ctx) =>
      deleteAdminRedirectsHandler(ctx),
    );

export const createAdminOptionsRoutes = () =>
  new Elysia().use(userOptionsRoutes()).use(adminOnlyRoutes());

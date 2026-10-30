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
  getOptionsOpmlHandler,
  opmlRequest,
  postOptionsOpmlHandler,
} from "#features/admin/routes/options-opml.ts";
import type * as runtime from "#platform/runtime.ts";
import type * as auth from "#features/auth/services.ts";
import type * as feeds from "#features/feeds/services.ts";

export type AdminRouteServices = Pick<
  typeof auth,
  "authThrottle" | "usersDataService"
> &
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
const userOptionsRoutes = (services: AdminRouteServices) => {
  const { authThrottle, password, usersDataService } = services;
  return (
    new Elysia()
      .use(createAuthPlugin(services))
      .post(
        "/api/options/password",
        { body: passwordRequest },
        async ({ body, sid, user }) => {
          const incorrect = json(
            { error: "Current password is incorrect." },
            400,
          );
          // Keyed by user, not address; see ThrottleScope.
          const key = `user:${user.id}`;
          if (await authThrottle.blocked("password-change", key, user.email))
            return incorrect;
          const account = await usersDataService.findUser(user.email);
          if (
            !account ||
            !(await password.verify(body.oldPassword, account.password))
          ) {
            await authThrottle.recordFailure(
              "password-change",
              key,
              user.email,
            );
            return incorrect;
          }
          const updated = await usersDataService.updatePassword(
            account.id,
            account.password,
            await password.hash(body.password1),
            sid,
          );
          if (!updated) return incorrect;
          await authThrottle.clearFailures("password-change", key, user.email);
          return json({ success: true });
        },
      )
      .post("/api/options/opml", { body: opmlRequest }, (ctx) =>
        postOptionsOpmlHandler(ctx, services),
      )
      .get("/api/options/opml", (ctx) => getOptionsOpmlHandler(ctx, services))
      // The current session is flagged rather than filtered server-side: the
      // page needs to show it ("this session"), and the caller's own sign-out
      // already has a route -- POST /api/logout -- that also clears the
      // cookie.
      .get("/api/options/sessions", async ({ sid, user }) =>
        json({ sessions: await usersDataService.listSessions(user.id, sid) }),
      )
      .delete("/api/options/sessions/:id", async ({ params, user }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id))
          return json({ error: "Unknown session." }, 400);
        await usersDataService.deleteSessionById(user.id, id);
        return json({ success: true });
      })
      .delete("/api/options/sessions", async ({ sid, user }) => {
        await usersDataService.deleteOtherSessions(user.id, sid);
        return json({ success: true });
      })
  );
};

const adminOnlyRoutes = (services: AdminRouteServices) => {
  const { redirectMap, sourcesDataService } = services;
  return new Elysia()
    .use(createAdminPlugin(services))
    .get("/api/admin", { query: adminQuery }, async ({ query }) =>
      json(
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
          return json({ error: "Source URL already exists" }, 409);
        if (result === "not-found")
          return json({ error: "Source URL not found" }, 404);
        return json({ success: true });
      },
    )
    .delete("/api/admin", { body: removeSourceRequest }, async ({ body }) => {
      await sourcesDataService.deleteSource(body.removeSourceId);
      return json(body.removeSourceId);
    })
    .get("/api/admin/redirects", async () =>
      json(await redirectMap.getAllRedirects()),
    )
    .delete(
      "/api/admin/redirects",
      { body: redirectDeletionRequest },
      async ({ body }) => {
        await redirectMap.removeRedirect(body.oldUrl);
        return json({ success: true });
      },
    );
};

export const createAdminOptionsRoutes = (services: AdminRouteServices) =>
  new Elysia().use(userOptionsRoutes(services)).use(adminOnlyRoutes(services));

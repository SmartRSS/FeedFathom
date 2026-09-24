import { Elysia } from "elysia";
import { usersDataService } from "#features/auth/services.ts";

// The read-only lookup for GET /api/session, which answers "who is this?"
// without counting as activity. Routes behind the plugin go through
// authenticate instead, which resolves and stamps in one statement.
export async function userFor(sid: unknown) {
  if (typeof sid !== "string" || !sid) return null;
  const user = await usersDataService.getUserBySid(sid);
  return user?.status === "active" ? user : null;
}

// The shape route handlers see as `user` once createAuthPlugin has run --
// handler files import this instead of re-deriving it from UsersDataService.
export type AuthedUser = NonNullable<Awaited<ReturnType<typeof userFor>>>;

/**
 * 'plugin' scope: visible to this instance's own routes and to whichever
 * single parent composes it via `.use()` (e.g. reader.ts), but doesn't leak
 * further up into unrelated sibling route groups composed in server-app.ts.
 */
function sessionPlugin(requireAdmin: boolean) {
  return new Elysia().derive("plugin", async ({ cookie, request, status }) => {
    const sid = cookie["sid"]?.value;
    const user =
      typeof sid === "string" && sid
        ? await usersDataService.authenticate(
            sid,
            request.headers.get("user-agent"),
          )
        : undefined;
    if (!user) return status(401, { error: "Unauthorized" });
    if (requireAdmin && !user.isAdmin)
      return status(403, { error: "Unauthorized" });
    return { user };
  });
}

export function createAuthPlugin() {
  return sessionPlugin(false);
}

/**
 * The same session check with the admin test folded in, so a route group
 * carries the requirement instead of each handler restating it. The check
 * belongs in the derive rather than in a second one chained after it: a
 * plugin-scoped derive reaches routes, not later hooks on the same instance,
 * so a separate admin derive would find no `user` to look at.
 */
export function createAdminPlugin() {
  return sessionPlugin(true);
}

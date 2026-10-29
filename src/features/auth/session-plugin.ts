import { Elysia } from "elysia";
import type * as auth from "#features/auth/services.ts";

type SessionServices = Pick<typeof auth, "usersDataService">;

// The read-only lookup for GET /api/session, which answers "who is this?"
// without counting as activity. Routes behind the plugin go through
// authenticate instead, which resolves and stamps in one statement.
export async function userFor(
  sid: unknown,
  { usersDataService }: SessionServices,
) {
  if (typeof sid !== "string" || !sid) return null;
  return (await usersDataService.getUserBySid(sid)) ?? null;
}

// The shape route handlers see as `user` once createAuthPlugin has run --
// handler files import this instead of re-deriving it from UsersDataService.
export type AuthedUser = NonNullable<Awaited<ReturnType<typeof userFor>>>;

/**
 * 'plugin' scope: visible to this instance's own routes and to whichever
 * single parent composes it via `.use()` (e.g. reader.ts), but doesn't leak
 * further up into unrelated sibling route groups composed in server-app.ts.
 */
function sessionPlugin(
  requireAdmin: boolean,
  { usersDataService }: SessionServices,
) {
  return new Elysia().derive("plugin", async ({ cookie, request, status }) => {
    const sid = cookie["sid"]?.value;
    if (typeof sid !== "string" || !sid)
      return status(401, { error: "Unauthorized" });
    const user = await usersDataService.authenticate(
      sid,
      request.headers.get("user-agent"),
    );
    if (!user) return status(401, { error: "Unauthorized" });
    if (requireAdmin && !user.isAdmin)
      return status(403, { error: "Unauthorized" });
    // The sid rides along so a route that names the current session (the
    // sessions list, the events stream's recheck) does not re-read the cookie.
    return { sid, user };
  });
}

export function createAuthPlugin(services: SessionServices) {
  return sessionPlugin(false, services);
}

/**
 * The same session check with the admin test folded in, so a route group
 * carries the requirement instead of each handler restating it. The check
 * belongs in the derive rather than in a second one chained after it: a
 * plugin-scoped derive reaches routes, not later hooks on the same instance,
 * so a separate admin derive would find no `user` to look at.
 */
export function createAdminPlugin(services: SessionServices) {
  return sessionPlugin(true, services);
}

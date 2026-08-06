import { Elysia } from "elysia";
import type { UsersDataService } from "../db/data-services/user-data-service.ts";

export function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, headers ? { headers, status } : { status });
}

export async function userFor(
  sid: unknown,
  usersDataService: Pick<UsersDataService, "getUserBySid">,
) {
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
export function createAuthPlugin(
  usersDataService: Pick<UsersDataService, "getUserBySid" | "touchLastSeen">,
) {
  return new Elysia().derive("plugin", async ({ cookie, status }) => {
    const user = await userFor(cookie["sid"]?.value, usersDataService);
    if (!user) return status(401, { error: "Unauthorized" });
    await usersDataService.touchLastSeen(user.id);
    return { user };
  });
}

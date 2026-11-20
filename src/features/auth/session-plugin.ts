import { Elysia } from "elysia";
import type * as auth from "#features/auth/services.ts";
import type { errorResponse } from "#shared/contracts/responses.ts";
import type { Static } from "typebox";
import { sessionCookie } from "#features/auth/routes/session-header.ts";

type SessionServices = Pick<typeof auth, "usersDataService">;

export async function userFor(
  sid: unknown,
  { usersDataService }: SessionServices,
) {
  if (typeof sid !== "string" || !sid) return null;
  return (await usersDataService.authenticate(sid, null, false)) ?? null;
}

export type AuthedUser = NonNullable<Awaited<ReturnType<typeof userFor>>>;

const unauthorized: Static<typeof errorResponse> = { error: "Unauthorized" };
const forbidden: Static<typeof errorResponse> = { error: "Forbidden" };

function sessionPlugin(
  requireAdmin: boolean,
  { usersDataService }: SessionServices,
) {
  return new Elysia().derive("plugin", async ({ cookie, request, status }) => {
    const sid = cookie[sessionCookie]?.value;
    if (typeof sid !== "string" || !sid) return status(401, unauthorized);
    const user = await usersDataService.authenticate(
      sid,
      request.headers.get("user-agent"),
    );
    if (!user) return status(401, unauthorized);
    if (requireAdmin && !user.isAdmin) return status(403, forbidden);
    return { sid, user };
  });
}

export function createAuthPlugin(services: SessionServices) {
  return sessionPlugin(false, services);
}

export function createAdminPlugin(services: SessionServices) {
  return sessionPlugin(true, services);
}

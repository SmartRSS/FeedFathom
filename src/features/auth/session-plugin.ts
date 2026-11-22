import { Elysia } from "elysia";
import type * as auth from "#features/auth/services.ts";
import type { errorResponse } from "#shared/contracts/responses.ts";
import type { Static } from "typebox";
import { sessionCookie } from "#features/auth/routes/session-header.ts";
import {
  accountHeader,
  accountMismatchStatus,
} from "#shared/contracts/headers.ts";

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
const otherAccount: Static<typeof errorResponse> = {
  error: "Signed in to another account",
};

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
    const named = request.headers.get(accountHeader);
    if (named !== null && named !== String(user.id))
      return status(accountMismatchStatus, otherAccount);
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

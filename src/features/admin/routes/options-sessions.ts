import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";

// Elysia's cookie jar types a value opaquely (logout guards it the same
  // way), so the sid extraction is narrowed here rather than at each route.
export const currentSidFromCookie = (
  cookie: { sid?: { value?: unknown } },
): string => {
  const value = cookie.sid?.value;
  return typeof value === "string" ? value : "";
};

export type OptionsSessionsRouteDependencies = {
  usersDataService: Pick<
    UsersDataService,
    "listSessions" | "deleteSessionById" | "deleteOtherSessions"
  >;
};

// The current session is flagged rather than filtered server-side: the page
// needs to show it ("this session"), and the caller's own sign-out already
// has a route -- POST /api/logout -- that also clears the cookie.
export async function getOptionsSessionsHandler(
  user: AuthedUser,
  currentSid: string,
  { usersDataService }: OptionsSessionsRouteDependencies,
) {
  const sessions = await usersDataService.listSessions(user.id, currentSid);
  return json({ sessions });
}

export async function deleteOptionsSessionHandler(
  user: AuthedUser,
  params: Record<string, string>,
  { usersDataService }: OptionsSessionsRouteDependencies,
) {
  const id = Number(params["id"]);
  if (!Number.isInteger(id)) return json({ error: "Unknown session." }, 400);
  await usersDataService.deleteSessionById(user.id, id);
  return json({ success: true });
}

export async function deleteOtherSessionsHandler(
  user: AuthedUser,
  currentSid: string,
  { usersDataService }: OptionsSessionsRouteDependencies,
) {
  await usersDataService.deleteOtherSessions(user.id, currentSid);
  return json({ success: true });
}

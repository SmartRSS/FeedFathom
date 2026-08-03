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

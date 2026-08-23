import { Elysia } from "elysia";
import { userFor } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";

export type SessionRouteDependencies = {
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createSessionRoute({
  usersDataService,
}: SessionRouteDependencies) {
  return new Elysia().get("/api/session", async ({ cookie }) => {
    const user = await userFor(cookie["sid"]?.value, usersDataService);
    return user ? json({ user }) : json({ user: null });
  });
}

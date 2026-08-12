import { Elysia } from "elysia";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { json, userFor } from "../shared.ts";

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

import { Elysia } from "elysia";
import { json } from "#platform/http/json.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { sessionHeader } from "./session-header.ts";

export type LogoutRouteDependencies = {
  secureCookies: boolean;
  usersDataService: Pick<UsersDataService, "deleteSession">;
};

export function createLogoutRoute({
  secureCookies,
  usersDataService,
}: LogoutRouteDependencies) {
  return new Elysia().post("/api/logout", async ({ cookie }) => {
    const sid = cookie["sid"]?.value;
    if (typeof sid === "string") await usersDataService.deleteSession(sid);
    return json({ success: true }, 200, {
      "set-cookie": sessionHeader("", secureCookies, 0),
    });
  });
}

import { usersDataService } from "#features/auth/services.ts";
import { Elysia } from "elysia";
import { json } from "#platform/http/json.ts";
import { sessionHeader } from "#features/auth/routes/session-header.ts";

export function createLogoutRoute(secureCookies: boolean) {
  return new Elysia().post("/api/logout", async ({ cookie }) => {
    const sid = cookie["sid"]?.value;
    if (typeof sid === "string") await usersDataService.deleteSession(sid);
    return json({ success: true }, 200, {
      "set-cookie": sessionHeader("", secureCookies, 0),
    });
  });
}

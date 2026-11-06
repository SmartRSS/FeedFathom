import type * as auth from "#features/auth/services.ts";
import type { AppConfig } from "#platform/config.ts";
import { Elysia } from "elysia";
import { json } from "#platform/http/json.ts";
import { successResponse } from "#shared/contracts/responses.ts";
import {
  sessionCookie,
  sessionHeader,
} from "#features/auth/routes/session-header.ts";

export function createLogoutRoute({
  config,
  usersDataService,
}: Pick<typeof auth, "usersDataService"> & { config: AppConfig }) {
  return new Elysia().post("/api/logout", async ({ cookie }) => {
    const sid = cookie[sessionCookie]?.value;
    if (typeof sid === "string") await usersDataService.deleteSession(sid);
    return json(successResponse, { success: true }, 200, {
      "set-cookie": sessionHeader("", config.production, 0),
    });
  });
}

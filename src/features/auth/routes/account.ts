import type * as runtime from "#platform/runtime.ts";
import type * as auth from "#features/auth/services.ts";
import { Elysia } from "elysia";
import { passwordRequest, sessionParams } from "#shared/contracts/requests.ts";
import { createAuthPlugin } from "#features/auth/session-plugin.ts";
import { json, jsonError } from "#platform/http/json.ts";
import {
  sessionsResponse,
  successResponse,
} from "#shared/contracts/responses.ts";

// The signed-in account's own settings: its password and its sessions.
export function createAccountRoutes(
  services: Pick<typeof auth, "authThrottle" | "usersDataService"> &
    Pick<typeof runtime, "password">,
) {
  const { authThrottle, password, usersDataService } = services;
  return (
    new Elysia()
      .use(createAuthPlugin(services))
      .post(
        "/api/options/password",
        { body: passwordRequest },
        async ({ body, sid, user }) => {
          const incorrect = jsonError("Current password is incorrect.", 400);
          // The caller is signed in, so saying it was throttled reveals
          // nothing about which accounts exist.
          if (!(await authThrottle.attemptPasswordChange(user.id)))
            return jsonError("Too many attempts. Try again later.", 429);
          const account = await usersDataService.findUser(user.email);
          if (
            !account ||
            !(await password.verify(body.oldPassword, account.password))
          )
            return incorrect;
          const updated = await usersDataService.updatePassword(
            account.id,
            account.password,
            await password.hash(body.password1),
            sid,
          );
          if (!updated) return incorrect;
          await authThrottle.passwordChanged(user.id);
          return json(successResponse, { success: true });
        },
      )
      // The current session is flagged rather than filtered out: the page
      // shows it as "this session", and signing it out is POST /api/logout,
      // which also clears the cookie.
      .get("/api/options/sessions", async ({ sid, user }) =>
        json(sessionsResponse, {
          sessions: await usersDataService.listSessions(user.id, sid),
        }),
      )
      .delete(
        "/api/options/sessions/:id",
        { params: sessionParams },
        async ({ params, user }) => {
          await usersDataService.deleteSessionById(user.id, params.id);
          return json(successResponse, { success: true });
        },
      )
      .delete("/api/options/sessions", async ({ sid, user }) => {
        await usersDataService.deleteOtherSessions(user.id, sid);
        return json(successResponse, { success: true });
      })
  );
}

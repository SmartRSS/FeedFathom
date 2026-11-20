import type * as runtime from "#platform/runtime.ts";
import type * as auth from "#features/auth/services.ts";
import type { AppConfig } from "#platform/config.ts";
import { Elysia } from "elysia";
import { loginRequest } from "#shared/contracts/requests.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { successResponse } from "#shared/contracts/responses.ts";
import { clientAddress } from "#features/auth/routes/client-address.ts";
import { sessionHeader } from "#features/auth/routes/session-header.ts";

export function createLoginRoute({
  authThrottle,
  config,
  password,
  usersDataService,
}: Pick<typeof auth, "authThrottle" | "usersDataService"> &
  Pick<typeof runtime, "password"> & { config: AppConfig }) {
  return new Elysia().post(
    "/api/login",
    { body: loginRequest },
    async ({ body: parsed, request, server }) => {
      const address = clientAddress(
        request,
        server,
        config.TRUSTED_PROXY_HEADER,
      );
      const wrongLoginData = jsonError("Email or password is wrong.", 401);

      if (!(await authThrottle.attempt("login", address, parsed.email))) {
        return wrongLoginData;
      }

      const user = await usersDataService.findUser(parsed.email);
      if (
        !user ||
        !(await password.verify(parsed.password, user.password)) ||
        user.status !== "active"
      ) {
        if (!user) await password.hash(parsed.password);
        return wrongLoginData;
      }

      const sid = await usersDataService.createSession(
        user.id,
        user.password,
        request.headers.get("user-agent"),
      );
      if (!sid) return wrongLoginData;
      await authThrottle.succeeded("login", address, parsed.email);
      return json(successResponse, { success: true }, 200, {
        "set-cookie": sessionHeader(sid, config.production),
      });
    },
  );
}

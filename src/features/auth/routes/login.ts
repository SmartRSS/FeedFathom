import type * as runtime from "#platform/runtime.ts";
import type * as auth from "#features/auth/services.ts";
import type { AppConfig } from "#platform/config.ts";
import { Elysia } from "elysia";
import { loginRequest } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";
import { clientAddress } from "#features/auth/routes/client-address.ts";
import { sessionHeader } from "#features/auth/routes/session-header.ts";

export function createLoginRoute(
  secureCookies: boolean,
  {
    authThrottle,
    config,
    password,
    usersDataService,
  }: Pick<typeof auth, "authThrottle" | "usersDataService"> &
    Pick<typeof runtime, "password"> & { config: AppConfig },
) {
  return new Elysia().post(
    "/api/login",
    { body: loginRequest },
    async ({ body: parsed, request, server }) => {
      const address = clientAddress(
        request,
        server,
        config.TRUSTED_PROXY_HEADER,
      );
      // Same body and status as a wrong password. A distinguishable response
      // would undo the equal-time hashing below by answering "this account
      // exists and someone is guessing at it" for free.
      const wrongLoginData = json({ error: "Wrong login data" }, 401);

      // Counted before the password is checked, so a burst of parallel
      // guesses cannot all pass; a success takes its attempt back below.
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

      // Store what the client says it is, so the options page's session list
      // can tell rows apart; createSession falls back to "UNKNOWN" when the
      // header is absent. No sid means a password reset replaced the hash
      // verified above, which answers like any other wrong password.
      const sid = await usersDataService.createSession(
        user.id,
        user.password,
        request.headers.get("user-agent"),
      );
      if (!sid) return wrongLoginData;
      await authThrottle.succeeded("login", address, parsed.email);
      return json({ sid }, 200, {
        "set-cookie": sessionHeader(sid, secureCookies),
      });
    },
  );
}

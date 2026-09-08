import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { loginRequest } from "#shared/contracts/requests.ts";
import type { AppConfig } from "#platform/config.ts";
import { json } from "#platform/http/json.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";
import type { AuthThrottle } from "#features/auth/auth-throttle.ts";
import { clientAddress } from "#features/auth/routes/client-address.ts";
import { sessionHeader } from "#features/auth/routes/session-header.ts";

type Password = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export type LoginRouteDependencies = {
  config: Pick<AppConfig, "TRUSTED_PROXY_HEADER">;
  authThrottle: Pick<
    AuthThrottle,
    "blocked" | "clearFailures" | "recordFailure"
  >;
  password: Password;
  secureCookies: boolean;
  usersDataService: {
    createSession(userId: number, userAgent?: null | string): Promise<string>;
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
  };
};

export function createLoginRoute({
  config,
  authThrottle,
  password,
  secureCookies,
  usersDataService,
}: LoginRouteDependencies) {
  return new Elysia().post(
    "/api/login",
    { body: loginRequest },
    async ({ body, request, server }) => {
      // Elysia 2.0-beta doesn't run Codec .Decode() transforms on bodies.
      const parsed = Value.Decode(loginRequest, body);
      const address = clientAddress(
        request,
        server,
        config.TRUSTED_PROXY_HEADER,
      );
      // Same body and status as a wrong password. A distinguishable response
      // would undo the equal-time hashing below by answering "this account
      // exists and someone is guessing at it" for free.
      const wrongLoginData = json({ error: "Wrong login data" }, 401);

      if (await authThrottle.blocked("login", address, parsed.email)) {
        return wrongLoginData;
      }

      const user = await usersDataService.findUser(parsed.email);
      if (
        !user ||
        !(await password.verify(parsed.password, user.password)) ||
        user.status !== "active"
      ) {
        if (!user) await password.hash(parsed.password);
        await authThrottle.recordFailure("login", address, parsed.email);
        return wrongLoginData;
      }

      await authThrottle.clearFailures("login", address, parsed.email);
      // Store what the client says it is, so the options page's session list
      // can tell rows apart; createSession falls back to "UNKNOWN" when the
      // header is absent.
      const sid = await usersDataService.createSession(
        user.id,
        request.headers.get("user-agent"),
      );
      return json({ sid }, 200, {
        "set-cookie": sessionHeader(sid, secureCookies),
      });
    },
  );
}

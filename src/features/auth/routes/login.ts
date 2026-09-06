import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { loginRequest } from "#shared/contracts/requests.ts";
import type { AppConfig } from "#platform/config.ts";
import { json } from "#platform/http/json.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";
import type { LoginThrottle } from "#features/auth/login-throttle.ts";
import { sessionHeader } from "#features/auth/routes/session-header.ts";

type Password = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export type LoginRouteDependencies = {
  config: Pick<AppConfig, "TRUSTED_PROXY_HEADER">;
  loginThrottle: Pick<
    LoginThrottle,
    "blocked" | "clearFailures" | "recordFailure"
  >;
  password: Password;
  secureCookies: boolean;
  usersDataService: {
    createSession(userId: number, userAgent?: null | string): Promise<string>;
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
  };
};

// X-Forwarded-For is a chain the proxies append to, so the leftmost entry is
// the one the first proxy saw. It is only as trustworthy as the proxy that
// wrote it, which is what makes reading it opt-in.
function clientAddress(
  request: Request,
  server: { requestIP(request: Request): null | { address: string } } | null,
  trustedHeader: string | undefined,
): string {
  const forwarded = trustedHeader
    ? request.headers.get(trustedHeader)?.split(",")[0]?.trim()
    : undefined;
  if (forwarded) return forwarded;
  return server?.requestIP(request)?.address ?? "unknown";
}

export function createLoginRoute({
  config,
  loginThrottle,
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

      if (await loginThrottle.blocked(address, parsed.email)) {
        return wrongLoginData;
      }

      const user = await usersDataService.findUser(parsed.email);
      if (
        !user ||
        !(await password.verify(parsed.password, user.password)) ||
        user.status !== "active"
      ) {
        if (!user) await password.hash(parsed.password);
        await loginThrottle.recordFailure(address, parsed.email);
        return wrongLoginData;
      }

      await loginThrottle.clearFailures(address, parsed.email);
      const sid = await usersDataService.createSession(user.id, "");
      return json({ sid }, 200, {
        "set-cookie": sessionHeader(sid, secureCookies),
      });
    },
  );
}

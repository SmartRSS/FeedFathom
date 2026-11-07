import type { AppConfig } from "#platform/config.ts";
import type * as auth from "#features/auth/services.ts";
import { Elysia } from "elysia";
import { userFor } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import { sessionResponse } from "#shared/contracts/responses.ts";
import { sessionCookie } from "#features/auth/routes/session-header.ts";

export function createSessionRoute(
  services: Pick<typeof auth, "usersDataService"> & { config: AppConfig },
) {
  const { mailDomain } = services.config;
  return new Elysia().get("/api/session", async ({ cookie }) => {
    const user = await userFor(cookie[sessionCookie]?.value, services);
    return json(sessionResponse, {
      ...(mailDomain ? { mailDomain } : {}),
      user,
    });
  });
}

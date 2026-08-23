import { Elysia } from "elysia";
import type { AppConfig } from "#platform/config.ts";
import { userFor } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";

export type SessionRouteDependencies = {
  config: Pick<AppConfig, "FEED_FATHOM_DOMAIN" | "MAIL_ENABLED">;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createSessionRoute({
  config,
  usersDataService,
}: SessionRouteDependencies) {
  // Absent unless this deployment actually ingests mail: the SPA reads it
  // both as "email subscriptions work here" and as the host to mint a
  // newsletter address at.
  // FEED_FATHOM_DOMAIN carries the public port for link building
  // (localhost:3456 in dev); an address host never has one.
  const domain = config.FEED_FATHOM_DOMAIN?.trim().replace(/:\d+$/u, "");
  const mail = config.MAIL_ENABLED && domain ? { mailDomain: domain } : {};
  return new Elysia().get("/api/session", async ({ cookie }) => {
    const user = await userFor(cookie["sid"]?.value, usersDataService);
    return json({ ...mail, user: user ?? null });
  });
}

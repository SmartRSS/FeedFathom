import type { AppConfig } from "#platform/config.ts";
import { newsletterMailDomain } from "#shared/util/newsletter-address.ts";
import type * as auth from "#features/auth/services.ts";
import { Elysia } from "elysia";
import { userFor } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";

export function createSessionRoute(
  services: Pick<typeof auth, "usersDataService"> & { config: AppConfig },
) {
  const { config } = services;
  // Absent unless this deployment actually ingests mail: the SPA reads it
  // both as "email subscriptions work here" and as the host to mint a
  // newsletter address at.
  const domain = newsletterMailDomain(config);
  const mail = domain ? { mailDomain: domain } : {};
  return new Elysia().get("/api/session", async ({ cookie }) => {
    const user = await userFor(cookie["sid"]?.value, services);
    return json({ ...mail, user: user ?? null });
  });
}

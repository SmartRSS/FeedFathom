import { Elysia } from "elysia";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { createAuthPlugin, json } from "../shared.ts";

export type OptionsRouteDependencies = {
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createOptionsRoute({
  usersDataService,
}: OptionsRouteDependencies) {
  return new Elysia()
    .use(createAuthPlugin(usersDataService))
    .get("/api/options", ({ user }) => json({ user }));
}

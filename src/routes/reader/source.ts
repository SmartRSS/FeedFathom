import { Elysia } from "elysia";
import { removeSourceRequest } from "../../contracts/requests.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { createAuthPlugin, json } from "../shared.ts";

export type SourceRouteDependencies = {
  userSourcesDataService: Pick<UserSourcesDataService, "removeSourceFromUser">;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createSourceRoute({
  userSourcesDataService,
  usersDataService,
}: SourceRouteDependencies) {
  return new Elysia().use(createAuthPlugin(usersDataService)).delete(
    "/api/source",
    { body: removeSourceRequest },
    async ({ body, user }) => {
      await userSourcesDataService.removeSourceFromUser(
        user.id,
        body.removeSourceId,
      );
      return json(body.removeSourceId);
    },
  );
}

import type { Static } from "typebox";
import { removeSourceRequest } from "../../contracts/requests.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import { type AuthedUser, json } from "../shared.ts";

export type SourceRouteDependencies = {
  userSourcesDataService: Pick<UserSourcesDataService, "removeSourceFromUser">;
};

export async function deleteSourceHandler(
  { body, user }: { body: Static<typeof removeSourceRequest>; user: AuthedUser },
  { userSourcesDataService }: SourceRouteDependencies,
) {
  await userSourcesDataService.removeSourceFromUser(
    user.id,
    body.removeSourceId,
  );
  return json(body.removeSourceId);
}

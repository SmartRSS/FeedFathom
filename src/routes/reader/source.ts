import type { Static } from "typebox";
import type {
  removeSourceRequest,
  updateSourceRequest,
} from "../../contracts/requests.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import { type AuthedUser, json } from "../shared.ts";

export type SourceRouteDependencies = {
  userSourcesDataService: Pick<
    UserSourcesDataService,
    "removeSourceFromUser" | "updateUserSource"
  >;
};

export async function deleteSourceHandler(
  {
    body,
    user,
  }: { body: Static<typeof removeSourceRequest>; user: AuthedUser },
  { userSourcesDataService }: SourceRouteDependencies,
) {
  await userSourcesDataService.removeSourceFromUser(
    user.id,
    body.removeSourceId,
  );
  return json(body.removeSourceId);
}

export async function patchSourceHandler(
  {
    body,
    user,
  }: { body: Static<typeof updateSourceRequest>; user: AuthedUser },
  { userSourcesDataService }: SourceRouteDependencies,
) {
  const updated = await userSourcesDataService.updateUserSource(
    user.id,
    body.sourceId,
    { name: body.sourceName, parentId: body.sourceFolder },
  );
  if (!updated) return json({ error: "Invalid folder or source" }, 400);
  return json({ sourceId: updated.id });
}

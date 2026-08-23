import type { Static } from "typebox";
import type {
  removeSourceRequest,
  updateSourceRequest,
} from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";

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

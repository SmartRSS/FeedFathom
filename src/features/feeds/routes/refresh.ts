import type * as feeds from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { refreshSourceRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { successResponse } from "#shared/contracts/responses.ts";

// Fetches one of the user's subscriptions now instead of at its next
// scheduled poll, which after repeated failures can be over an hour away.
// The worker records the outcome as for any poll, and the tree shows it.
export async function postRefreshSourceHandler(
  {
    body,
    user,
  }: {
    body: StaticDecode<typeof refreshSourceRequest>;
    user: Pick<AuthedUser, "id">;
  },
  {
    outboundFetchBudget,
    sourceEnqueuer,
    userSourcesDataService,
  }: Pick<
    typeof feeds,
    "outboundFetchBudget" | "sourceEnqueuer" | "userSourcesDataService"
  >,
) {
  await outboundFetchBudget.consume(user.id);
  if (!(await userSourcesDataService.isSubscribed(user.id, body.sourceId)))
    return jsonError("Invalid source", 400);
  await sourceEnqueuer.enqueueSource({ id: body.sourceId });
  return json(successResponse, { success: true });
}

import type * as feeds from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { refreshSourceRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { successResponse } from "#shared/contracts/responses.ts";

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
    sourceJobs,
    userSourcesDataService,
  }: Pick<
    typeof feeds,
    "outboundFetchBudget" | "sourceJobs" | "userSourcesDataService"
  >,
) {
  await outboundFetchBudget.consume(user.id);
  if (!(await userSourcesDataService.isSubscribed(user.id, body.sourceId)))
    return jsonError("Invalid source", 400);
  await sourceJobs.refresh([body.sourceId]);
  return json(successResponse, { success: true });
}

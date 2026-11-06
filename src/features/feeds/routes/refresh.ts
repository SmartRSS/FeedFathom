import type * as feeds from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { refreshSourceRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";

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
  // Each call is an outbound fetch the user asked for, like find and preview.
  await outboundFetchBudget.consume(user.id);
  const source = await userSourcesDataService.getSubscribedSource(
    user.id,
    body.sourceId,
  );
  if (!source) return json({ error: "Invalid source" }, 400);
  await sourceEnqueuer.enqueueSource(source);
  return json({ success: true });
}

import type * as feeds from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { findQuery } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { foundFeedsResponse } from "#shared/contracts/responses.ts";

export async function getFindHandler(
  {
    query: decoded,
    request,
    user,
  }: {
    request: Pick<Request, "signal">;
    query: StaticDecode<typeof findQuery>;
    user: Pick<AuthedUser, "id">;
  },
  {
    feedRequests,
    outboundFetchBudget,
  }: Pick<typeof feeds, "feedRequests" | "outboundFetchBudget">,
) {
  await outboundFetchBudget.consume(user.id);
  const reply = await feedRequests.find(decoded.link, request.signal);
  if ("invalid" in reply) return jsonError("Invalid feed url", 400);
  return json(foundFeedsResponse, reply.feeds);
}

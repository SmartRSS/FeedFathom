import type * as feeds from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { previewQuery } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import { errorResponse, previewResponse } from "#shared/contracts/responses.ts";
import { classifyFetchFailure } from "#shared/util/fetch-failure.ts";

export async function getPreviewHandler(
  {
    query: decoded,
    request,
    user,
  }: {
    request: Pick<Request, "signal">;
    query: StaticDecode<typeof previewQuery>;
    user: AuthedUser;
  },
  {
    feedRequests,
    outboundFetchBudget,
  }: Pick<typeof feeds, "feedRequests" | "outboundFetchBudget">,
) {
  await outboundFetchBudget.consume(user.id);
  const reply = await feedRequests.preview(
    user.id,
    decoded.feedUrl,
    request.signal,
  );
  if ("failure" in reply)
    return json(
      errorResponse,
      {
        detail: reply.failure,
        error: classifyFetchFailure(reply.failure).sentence,
      },
      400,
    );
  return json(previewResponse, reply.preview);
}

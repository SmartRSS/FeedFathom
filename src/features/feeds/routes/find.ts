import type * as feeds from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { findQuery } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import type { HttpResponse } from "#platform/http/http-client.ts";
import { isNoAnswerError } from "#platform/http/http-deferred-error.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { foundFeedsResponse } from "#shared/contracts/responses.ts";
import { markWebSubAvailability } from "#features/feeds/feed-discovery.ts";
import { scanHtml } from "#features/feeds/html-scanner.ts";
import { openRssSuggestion } from "#shared/scanners/scanner.ts";
import { decodeHtml } from "#shared/util/decode-body.ts";

export async function getFindHandler(
  {
    query: decoded,
    user,
  }: {
    query: StaticDecode<typeof findQuery>;
    user: Pick<AuthedUser, "id">;
  },
  {
    feedParser,
    httpClient,
    outboundFetchBudget,
  }: Pick<typeof feeds, "feedParser" | "outboundFetchBudget"> & {
    httpClient: {
      get(url: string): Promise<Pick<HttpResponse, "data" | "headers" | "url">>;
    };
  },
) {
  await outboundFetchBudget.consume(user.id);
  try {
    const response = await httpClient.get(decoded.link);
    const html = decodeHtml(
      new Uint8Array(response.data),
      response.headers.get("content-type"),
    );
    const feeds = scanHtml(response.url, html);
    if (!feeds.length)
      return json(foundFeedsResponse, [
        { ...openRssSuggestion(response.url), websub: false },
      ]);
    return json(
      foundFeedsResponse,
      await markWebSubAvailability(feeds, feedParser),
    );
  } catch (error_: unknown) {
    if (isNoAnswerError(error_)) throw error_;
    return jsonError("Invalid feed url", 400);
  }
}

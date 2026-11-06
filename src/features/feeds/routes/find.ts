import type * as feeds from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { findQuery } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import type { HttpResponse } from "#platform/http/http-client.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { HttpDeadlineError } from "#platform/http/request-deadline.ts";
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
    // The one call find makes: a page's bytes, its headers for the charset,
    // and where it ended up.
    httpClient: {
      get(
        url: string,
        options: { responseType: "arrayBuffer" },
      ): Promise<Pick<HttpResponse<ArrayBuffer>, "data" | "headers" | "url">>;
    };
  },
) {
  // Counted before any outbound work, including a cache hit: the budget is
  // about how often a user can ask us to reach out at all.
  await outboundFetchBudget.consume(user.id);
  try {
    const response = await httpClient.get(decoded.link, {
      responseType: "arrayBuffer",
    });
    const html = decodeHtml(
      new Uint8Array(response.data),
      response.headers.get("content-type"),
    );
    const feeds = scanHtml(response.url, html);
    // For a page that advertises nothing, OpenRSS is offered but not probed:
    // probing would send the page address to openrss.org before the user
    // chose to, and previewing the suggestion is that choice.
    if (!feeds.length)
      return json(foundFeedsResponse, [
        { ...openRssSuggestion(response.url), websub: false },
      ]);
    return json(
      foundFeedsResponse,
      await markWebSubAvailability(feeds, feedParser),
    );
  } catch (error_: unknown) {
    // A deferral is not this handler's to classify -- the central error hook
    // turns it into a 429 with a Retry-After. Neither is our own deadline
    // running out, which is a 504 and not the user's URL being wrong.
    // Anything else here is a failure to fetch a URL the user supplied,
    // which is a client error.
    if (
      error_ instanceof HttpDeferredError ||
      error_ instanceof HttpDeadlineError
    )
      throw error_;
    return jsonError("Invalid feed url", 400);
  }
}

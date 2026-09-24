import { httpClient } from "#platform/runtime.ts";
import { feedParser } from "#features/feeds/services.ts";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { findQuery } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { outboundFetchBudget } from "#features/auth/services.ts";
import { isHttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { isHttpDeadlineError } from "#platform/http/request-deadline.ts";
import { json } from "#platform/http/json.ts";
import { markWebSubAvailability } from "#features/feeds/feed-discovery.ts";
import { scanHtml } from "#shared/scanners/scanner.ts";

export async function getFindHandler({
  query,
  user,
}: {
  query: Static<typeof findQuery>;
  user: AuthedUser;
}) {
  const decoded = Value.Decode(findQuery, query);
  // Counted before any outbound work, including a cache hit: the budget is
  // about how often a user can ask us to reach out at all.
  await outboundFetchBudget.consume(user.id);
  try {
    const response = await httpClient.get(decoded.link);
    const feeds = scanHtml(response.url, response.data);
    // Unreachable while scanHtml falls back to an OpenRSS suggestion for a
    // page that advertises nothing; live again if that fallback ever goes.
    if (!feeds.length) return json({ error: "Invalid feed url" }, 400);
    return json(await markWebSubAvailability(feeds, feedParser));
  } catch (error_: unknown) {
    // A deferral is not this handler's to classify -- the central error hook
    // turns it into a 429 with a Retry-After. Neither is our own deadline
    // running out, which is a 504 and not the user's URL being wrong.
    // Anything else here is a failure to fetch a URL the user supplied,
    // which is a client error.
    if (isHttpDeferredError(error_) || isHttpDeadlineError(error_))
      throw error_;
    return json({ error: "Invalid feed url" }, 400);
  }
}

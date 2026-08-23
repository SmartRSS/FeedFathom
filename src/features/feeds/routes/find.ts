import type { Static } from "typebox";
import { Value } from "typebox/value";
import { findQuery } from "#shared/contracts/requests.ts";
import { isHttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { json } from "#platform/http/json.ts";
import {
  markWebSubAvailability,
  type WebSubProbe,
} from "#features/feeds/feed-discovery.ts";
import { scanHtml } from "#shared/scanners/scanner.ts";

export type FindRouteDependencies = {
  feedParser: WebSubProbe;
  httpClient: {
    get(url: string): Promise<{ data: string }>;
  };
};

export async function getFindHandler(
  { query }: { query: Static<typeof findQuery> },
  { feedParser, httpClient }: FindRouteDependencies,
) {
  const decoded = Value.Decode(findQuery, query);
  try {
    const response = await httpClient.get(decoded.link);
    const feeds = scanHtml(decoded.link, response.data);
    // Unreachable while scanHtml falls back to an OpenRSS suggestion for a
    // page that advertises nothing; live again if that fallback ever goes.
    if (!feeds.length) return json({ error: "Invalid feed url" }, 400);
    return json(await markWebSubAvailability(feeds, feedParser));
  } catch (error_: unknown) {
    // A deferral is not this handler's to classify -- the central error hook
    // turns it into a 429 with a Retry-After. Anything else here is a failure
    // to fetch a URL the user supplied, which is a client error.
    if (isHttpDeferredError(error_)) throw error_;
    return json({ error: "Invalid feed url" }, 400);
  }
}

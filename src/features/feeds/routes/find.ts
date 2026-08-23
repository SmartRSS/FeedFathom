import type { Static } from "typebox";
import { Value } from "typebox/value";
import { findQuery } from "#shared/contracts/requests.ts";
import { isHttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { json } from "#platform/http/json.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import { scanHtml } from "#shared/scanners/scanner.ts";

export type FindRouteDependencies = {
  feedParser: Pick<FeedParser, "parseUrl">;
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
    if (!feeds.length) return json({ error: "Invalid feed url" }, 400);

    // Each found feed is fetched (through the normal cached/rate-limited
    // parse pipeline, not a bare request) just to check whether it
    // advertises a WebSub hub -- the discovery list wants to mark that
    // up front, before the user commits to subscribing. A candidate that
    // fails to parse (dead link, the OpenRSS placeholder fallback in
    // scanner.ts, ...) just isn't marked rather than dropped -- that
    // failure will surface anyway once they click through to preview it.
    const withWebSubStatus = await Promise.all(
      feeds.map(async (feed) => {
        let websub = false;
        try {
          websub = (await feedParser.parseUrl(feed.url)).websub !== undefined;
        } catch {
          // A candidate that fails to parse just isn't marked -- see
          // above -- rather than treated as an error here.
        }
        return { title: feed.title, url: feed.url, websub };
      }),
    );
    return json(withWebSubStatus);
  } catch (error_: unknown) {
    // A deferral is not this handler's to classify -- the central error hook
    // turns it into a 429 with a Retry-After. Anything else here is a failure
    // to fetch a URL the user supplied, which is a client error.
    if (isHttpDeferredError(error_)) throw error_;
    return json({ error: "Invalid feed url" }, 400);
  }
}

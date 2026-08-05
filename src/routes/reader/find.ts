import type { Static } from "typebox";
import { Value } from "typebox/value";
import { findQuery } from "../../contracts/requests.ts";
import { HttpDeferredError } from "../../lib/http-client.ts";
import { scanHtml } from "../../lib/scanner.ts";
import { json } from "../shared.ts";
import { deferredResponse } from "./deferred-response.ts";

export type FindRouteDependencies = {
  httpClient: {
    get(url: string): Promise<{ data: string }>;
  };
};

export async function getFindHandler(
  { query }: { query: Static<typeof findQuery> },
  { httpClient }: FindRouteDependencies,
) {
  const decoded = Value.Decode(findQuery, query);
  try {
    const response = await httpClient.get(decoded.link);
    const feeds = scanHtml(decoded.link, response.data);
    return feeds.length
      ? json(feeds)
      : json({ error: "Invalid feed url" }, 400);
  } catch (error_: unknown) {
    if (error_ instanceof HttpDeferredError) return deferredResponse(error_);
    return json({ error: "Invalid feed url" }, 400);
  }
}

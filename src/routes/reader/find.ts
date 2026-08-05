import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { findQuery } from "../../contracts/requests.ts";
import { HttpDeferredError } from "../../lib/http-client.ts";
import { scanHtml } from "../../lib/scanner.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { createAuthPlugin, json } from "../shared.ts";
import { deferredResponse } from "./deferred-response.ts";

export type FindRouteDependencies = {
  httpClient: {
    get(url: string): Promise<{ data: string }>;
  };
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createFindRoute({
  httpClient,
  usersDataService,
}: FindRouteDependencies) {
  return new Elysia()
    .use(createAuthPlugin(usersDataService))
    .get("/api/find", { query: findQuery }, async ({ query }) => {
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
    });
}

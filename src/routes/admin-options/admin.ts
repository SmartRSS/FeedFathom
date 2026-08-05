import type { Static } from "typebox";
import { Value } from "typebox/value";
import {
  adminQuery,
  sourceUrlReplacementRequest,
} from "../../contracts/requests.ts";
import type {
  SourcesDataService,
  SourceUrlUpdateResult,
} from "../../db/data-services/source-data-service.ts";
import { type AuthedUser, json } from "../shared.ts";

export type AdminRouteDependencies = {
  sourcesDataService: Pick<SourcesDataService, "listAllSources"> & {
    updateSourceUrl(
      oldUrl: string,
      newUrl: string,
    ): Promise<SourceUrlUpdateResult | void>;
  };
};

export async function getAdminHandler(
  { query, user }: { query: Static<typeof adminQuery>; user: AuthedUser },
  { sourcesDataService }: AdminRouteDependencies,
) {
  if (!user.isAdmin) return json({ error: "Unauthorized" }, 403);
  return json(
    await sourcesDataService.listAllSources(
      query.sortBy ?? "createdAt",
      query.order ?? "asc",
    ),
  );
}

export async function postAdminHandler(
  { body, user }: { body: unknown; user: AuthedUser },
  { sourcesDataService }: AdminRouteDependencies,
) {
  if (!user.isAdmin) return json({ error: "Unauthorized" }, 403);
  // Elysia 2.0-beta doesn't run Codec .Decode() transforms on bodies.
  const decoded = Value.Decode(sourceUrlReplacementRequest, body);
  const result = await sourcesDataService.updateSourceUrl(
    decoded.oldUrl,
    decoded.newUrl,
  );
  if (result === "conflict")
    return json({ error: "Source URL already exists" }, 409);
  if (result === "not-found")
    return json({ error: "Source URL not found" }, 404);
  return json({ success: true });
}

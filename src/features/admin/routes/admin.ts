import { sourcesDataService } from "#features/feeds/services.ts";
import type { Static, StaticDecode } from "typebox";
import type {
  adminQuery,
  removeSourceRequest,
  sourceUrlReplacementRequest,
} from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";

export async function getAdminHandler({
  query,
}: {
  query: Static<typeof adminQuery>;
}) {
  return json(
    await sourcesDataService.listAllSources(
      query.sortBy ?? "createdAt",
      query.order ?? "asc",
    ),
  );
}

export async function postAdminHandler({
  body: decoded,
}: {
  body: StaticDecode<typeof sourceUrlReplacementRequest>;
}) {
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

export async function deleteAdminHandler({
  body,
}: {
  body: Static<typeof removeSourceRequest>;
}) {
  await sourcesDataService.deleteSource(body.removeSourceId);
  return json(body.removeSourceId);
}

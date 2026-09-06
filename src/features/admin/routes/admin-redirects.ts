import { Value } from "typebox/value";
import { redirectDeletionRequest } from "#shared/contracts/requests.ts";
import type { RedirectMap } from "#platform/http/redirect-map.ts";
import { json } from "#platform/http/json.ts";

export type AdminRedirectsRouteDependencies = {
  redirectMap: Pick<RedirectMap, "getAllRedirects" | "removeRedirect">;
};

export async function getAdminRedirectsHandler(
  _context: unknown,
  { redirectMap }: AdminRedirectsRouteDependencies,
) {
  return json(await redirectMap.getAllRedirects());
}

export async function deleteAdminRedirectsHandler(
  { body }: { body: unknown },
  { redirectMap }: AdminRedirectsRouteDependencies,
) {
  const decoded = Value.Decode(redirectDeletionRequest, body);
  await redirectMap.removeRedirect(decoded.oldUrl);
  return json({ success: true });
}

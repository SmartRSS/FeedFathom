import { Value } from "typebox/value";
import { redirectDeletionRequest } from "../../contracts/requests.ts";
import type { RedirectMap } from "../../lib/redirect-map.ts";
import { type AuthedUser, json } from "../shared.ts";

export type AdminRedirectsRouteDependencies = {
  redirectMap: Pick<RedirectMap, "getAllRedirects" | "removeRedirect">;
};

export async function getAdminRedirectsHandler(
  { user }: { user: AuthedUser },
  { redirectMap }: AdminRedirectsRouteDependencies,
) {
  return user.isAdmin
    ? json(await redirectMap.getAllRedirects())
    : json({ error: "Unauthorized" }, 403);
}

export async function deleteAdminRedirectsHandler(
  { body, user }: { body: unknown; user: AuthedUser },
  { redirectMap }: AdminRedirectsRouteDependencies,
) {
  if (!user.isAdmin) return json({ error: "Unauthorized" }, 403);
  const decoded = Value.Decode(redirectDeletionRequest, body);
  await redirectMap.removeRedirect(decoded.oldUrl);
  return json({ success: true });
}

import { Value } from "typebox/value";
import { redirectDeletionRequest } from "#shared/contracts/requests.ts";
import type { RedirectMap } from "#platform/http/redirect-map.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";

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

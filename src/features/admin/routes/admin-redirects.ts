import { redirectMap } from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { redirectDeletionRequest } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";

export async function getAdminRedirectsHandler(_context: unknown) {
  return json(await redirectMap.getAllRedirects());
}

export async function deleteAdminRedirectsHandler({
  body: decoded,
}: {
  body: StaticDecode<typeof redirectDeletionRequest>;
}) {
  await redirectMap.removeRedirect(decoded.oldUrl);
  return json({ success: true });
}

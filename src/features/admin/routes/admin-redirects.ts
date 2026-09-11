import { redirectMap } from "#features/feeds/services.ts";
import { Value } from "typebox/value";
import { redirectDeletionRequest } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";

export async function getAdminRedirectsHandler(_context: unknown) {
  return json(await redirectMap.getAllRedirects());
}

export async function deleteAdminRedirectsHandler({ body }: { body: unknown }) {
  const decoded = Value.Decode(redirectDeletionRequest, body);
  await redirectMap.removeRedirect(decoded.oldUrl);
  return json({ success: true });
}

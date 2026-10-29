import type * as feeds from "#features/feeds/services.ts";
import type { StaticDecode } from "typebox";
import type { redirectDeletionRequest } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";

type RedirectServices = Pick<typeof feeds, "redirectMap">;

export async function getAdminRedirectsHandler({
  redirectMap,
}: RedirectServices) {
  return json(await redirectMap.getAllRedirects());
}

export async function deleteAdminRedirectsHandler(
  {
    body: decoded,
  }: {
    body: StaticDecode<typeof redirectDeletionRequest>;
  },
  { redirectMap }: RedirectServices,
) {
  await redirectMap.removeRedirect(decoded.oldUrl);
  return json({ success: true });
}

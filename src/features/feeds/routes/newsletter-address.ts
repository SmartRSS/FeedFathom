import type * as feeds from "#features/feeds/services.ts";
import type { AppConfig } from "#platform/config.ts";
import type { StaticDecode } from "typebox";
import type { newsletterAddressRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { successResponse } from "#shared/contracts/responses.ts";
import { isNewsletterAddress } from "#shared/util/newsletter-address.ts";

export function newsletterHomeUrl(
  config: Pick<AppConfig, "publicOrigin">,
  request: Request,
) {
  return config.publicOrigin?.origin ?? new URL(request.url).origin;
}

export async function postNewsletterAddressHandler(
  {
    body,
    request,
    user,
  }: {
    body: StaticDecode<typeof newsletterAddressRequest>;
    request: Request;
    user: Pick<AuthedUser, "id">;
  },
  {
    config,
    outboundFetchBudget,
    sourcesDataService,
  }: Pick<typeof feeds, "outboundFetchBudget" | "sourcesDataService"> & {
    config: AppConfig;
  },
) {
  await outboundFetchBudget.consume(user.id);
  const domain = config.mailDomain;
  if (!domain) return jsonError("Email subscriptions are not allowed.", 400);
  if (!isNewsletterAddress(body.address, domain))
    return jsonError("Not a newsletter address of this server.", 400);
  await sourcesDataService.addSource({
    homeUrl: newsletterHomeUrl(config, request),
    kind: "email",
    reservedBy: user.id,
    url: body.address,
  });
  return json(successResponse, { success: true });
}

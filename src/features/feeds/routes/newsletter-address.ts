import type * as feeds from "#features/feeds/services.ts";
import type { AppConfig } from "#platform/config.ts";
import type { StaticDecode } from "typebox";
import type { newsletterAddressRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import {
  isNewsletterAddress,
  newsletterMailDomain,
} from "#shared/util/newsletter-address.ts";

// Creates the email source for an address the SPA just minted, before any
// subscription to it, so mail that arrives ahead of Subscribe is stored
// rather than bounced as an unknown recipient (#1116). Nobody sees that mail
// until this user subscribes; the orphan cleanup removes an address nobody
// subscribed to once it is a day old.
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
  // Nothing is fetched, but every call can add a row, and registration is
  // open: the allowance find, preview and subscribe share bounds that too.
  await outboundFetchBudget.consume(user.id);
  const domain = newsletterMailDomain(config);
  if (!domain)
    return json({ error: "Email subscriptions are not allowed." }, 400);
  // Only an address in the minted format on this instance's mail domain:
  // this endpoint is not a way to claim an address nothing here mints.
  if (!isNewsletterAddress(body.address, domain))
    return json({ error: "Not a newsletter address of this server." }, 400);
  // homeUrl as subscribe sets it for an email source. The address is this
  // user's from now on: no other account can subscribe to it. An existing
  // source, and whoever it belongs to, is left as it is, and the answer is
  // the same, so it reveals nothing about the address.
  await sourcesDataService.addSource({
    homeUrl: new URL(request.url).origin,
    kind: "email",
    reservedBy: user.id,
    url: body.address,
  });
  return json({ success: true });
}

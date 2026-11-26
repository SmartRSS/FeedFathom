import type * as feeds from "#features/feeds/services.ts";
import type { AppConfig } from "#platform/config.ts";
import type { StaticDecode } from "typebox";
import type { subscribeRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { invalidRequestMessage, json, jsonError } from "#platform/http/json.ts";
import { subscriptionResponse } from "#shared/contracts/responses.ts";
import { serializeFeedPreview } from "#features/feeds/feed-preview-cache.ts";
import { isImportableSnapshot } from "#features/feeds/feed-requests.ts";
import { isMintedNewsletterAddress } from "#shared/util/newsletter-address.ts";
import { newsletterHomeUrl } from "#features/feeds/routes/newsletter-address.ts";

export async function postSubscribeHandler(
  {
    body,
    request,
    user,
  }: {
    body: StaticDecode<typeof subscribeRequest>;
    request: Request;
    user: AuthedUser;
  },
  {
    config,
    feedPreviewCache,
    feedRequests,
    outboundFetchBudget,
    sourceEnqueuer,
    userSourcesDataService,
  }: Pick<
    typeof feeds,
    | "feedPreviewCache"
    | "feedRequests"
    | "outboundFetchBudget"
    | "sourceEnqueuer"
    | "userSourcesDataService"
  > & { config: AppConfig },
) {
  await outboundFetchBudget.consume(user.id);
  const { sourceUrl } = body;
  const isEmail = sourceUrl.kind === "email";
  const { mailDomain } = config;
  if (isEmail && !mailDomain)
    return jsonError("Email subscriptions are not allowed.", 400);
  const cachedPreview = isEmail
    ? undefined
    : await feedPreviewCache.get(user.id, sourceUrl.value);
  const subscription = await userSourcesDataService.addSourceToUser(user.id, {
    initializationSnapshot:
      cachedPreview && isImportableSnapshot(cachedPreview)
        ? serializeFeedPreview(cachedPreview)
        : null,
    name: body.sourceName,
    parentId: body.sourceFolder,
    url: sourceUrl.value,
    ...(isEmail && mailDomain
      ? {
          homeUrl: newsletterHomeUrl(config, request),
          kind: "email",
          minted: isMintedNewsletterAddress(sourceUrl.value, mailDomain),
        }
      : { homeUrl: cachedPreview?.link, kind: "feed" }),
  });
  if (!subscription) return jsonError("Invalid folder", 400);
  if (subscription === "refused") return jsonError(invalidRequestMessage, 422);
  if (subscription.initialized === true)
    return json(subscriptionResponse, { sourceId: subscription.source.id });

  if (!isEmail) {
    sourceEnqueuer
      .enqueueWebSubDiscovery(subscription.source.id)
      .catch((error: unknown) => {
        console.error(
          `WebSub discovery enqueue failed for source ${subscription.source.id}:`,
          error,
        );
      });
  }

  const snapshot = subscription.initializationSnapshot;
  const lease =
    await userSourcesDataService.withSubscriptionInitializationLease(
      subscription.subscriptionId,
      async () => {
        if (isEmail) return;
        if (snapshot === null) {
          await sourceEnqueuer.enqueueSource(subscription.source);
          return;
        }
        const imported = await feedRequests
          .importSnapshot(subscription.source.id, sourceUrl.value, snapshot)
          .catch(async (error: unknown) => {
            console.error(
              `Stored preview import failed for source ${subscription.source.id}; queueing a fetch:`,
              error,
            );
            await sourceEnqueuer.enqueueSource(subscription.source);
            return undefined;
          });
        if (imported && "invalid" in imported)
          throw new Error("Stored subscription snapshot is invalid");
      },
    );
  if (lease.outcome === "in-progress")
    return jsonError("Subscription initialization in progress", 409);

  return json(subscriptionResponse, { sourceId: subscription.source.id });
}

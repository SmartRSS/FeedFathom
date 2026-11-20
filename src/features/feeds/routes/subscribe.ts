import type * as feeds from "#features/feeds/services.ts";
import type { AppConfig } from "#platform/config.ts";
import type { StaticDecode } from "typebox";
import type { subscribeRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { invalidRequestMessage, json, jsonError } from "#platform/http/json.ts";
import { subscriptionResponse } from "#shared/contracts/responses.ts";
import {
  deserializeFeedPreview,
  serializeFeedPreview,
} from "#features/feeds/feed-preview-cache.ts";
import { isMintedNewsletterAddress } from "#shared/util/newsletter-address.ts";
import { newsletterHomeUrl } from "#features/feeds/routes/newsletter-address.ts";
import {
  type FeedPreview,
  mapFeedToArticles,
} from "#features/feeds/feed-mapper.ts";

function completePreview({
  feed,
  finalUrl,
  ...preview
}: FeedPreview): FeedPreview | undefined {
  if (!preview.truncated) return preview;
  if (!feed) return undefined;
  return {
    ...preview,
    articles: mapFeedToArticles(feed, preview.feedUrl, {
      baseUrl: finalUrl,
    }),
    truncated: false,
  };
}

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
    articleImporter,
    config,
    feedParser,
    feedPreviewCache,
    outboundFetchBudget,
    sourceEnqueuer,
    userSourcesDataService,
  }: Pick<
    typeof feeds,
    | "articleImporter"
    | "feedParser"
    | "feedPreviewCache"
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
  const importablePreview = cachedPreview && completePreview(cachedPreview);
  const subscription = await userSourcesDataService.addSourceToUser(user.id, {
    initializationSnapshot: importablePreview
      ? serializeFeedPreview(importablePreview)
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

  const preview =
    subscription.initializationSnapshot === null
      ? undefined
      : deserializeFeedPreview(
          subscription.initializationSnapshot,
          sourceUrl.value,
        );
  if (subscription.initializationSnapshot && !preview) {
    throw new Error("Stored subscription snapshot is invalid");
  }

  if (!isEmail) {
    void feedParser.discoverAndSubscribeWebSub(
      subscription.source.id,
      sourceUrl.value,
      subscription.source.websubStatus,
    );
  }

  const lease =
    await userSourcesDataService.withSubscriptionInitializationLease(
      subscription.subscriptionId,
      async () => {
        if (isEmail) return;
        if (preview) {
          try {
            await articleImporter.recordFetch(
              subscription.source.id,
              preview.articles,
              {
                alwaysRecount: true,
                cached: true,
                freshUntil: preview.freshUntil,
                trigger: "poll",
              },
            );
          } catch (error) {
            console.error(
              `Stored preview import failed for source ${subscription.source.id}; queueing a fetch:`,
              error,
            );
            await sourceEnqueuer.enqueueSource(subscription.source);
          }
        } else {
          await sourceEnqueuer.enqueueSource(subscription.source);
        }
      },
    );
  if (lease.outcome === "in-progress")
    return jsonError("Subscription initialization in progress", 409);

  return json(subscriptionResponse, { sourceId: subscription.source.id });
}

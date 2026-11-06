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
import {
  type FeedPreview,
  mapFeedToArticles,
} from "#features/feeds/feed-mapper.ts";

// A truncated preview holds only a sample of the feed. Its cached parsed feed
// is mapped in full here, once, so subscribe imports every article without a
// refetch. Without that feed, the caller queues the source for the worker.
// finalUrl is dropped too: only mapping needs it, and a replica still on the
// previous release rejects a stored snapshot that carries it.
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
          // A newsletter has no site of its own; it links back to this app.
          homeUrl: new URL(request.url).origin,
          kind: "email",
          minted: isMintedNewsletterAddress(sourceUrl.value, mailDomain),
        }
      : { homeUrl: cachedPreview?.link, kind: "feed" }),
  });
  if (!subscription) return jsonError("Invalid folder", 400);
  // Another account's newsletter address, or one this instance does not
  // mint. Answered exactly as a malformed target is (the validation error
  // server-app.ts maps), so a refusal says nothing about whether the address
  // exists or whose it is.
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

  // Left running rather than awaited: the response doesn't use its result,
  // and its hub POST can take up to the request deadline.
  // discoverAndSubscribeWebSub catches its own errors, so nothing here
  // needs to observe how it settles. If the process exits before it
  // finishes, a later parseSource poll re-discovers the hub: the next one
  // if the claim was never taken, otherwise once the pending source's daily
  // retry comes due. claimWebSubSubscribeAttempt keeps that retry from
  // double-subscribing.
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
        // An email source has nothing to fetch -- its articles arrive by
        // mail -- so enqueueing it would only have the worker try to parse
        // the address as a feed URL and fail the brand-new source. The
        // lease itself still runs, so the subscription counts as
        // initialized.
        if (isEmail) return;
        if (preview) {
          // A cached preview means the feed was already fetched and
          // parsed moments ago (e.g. during "load preview" in feed
          // discovery) -- inserting those already-parsed articles is a
          // plain DB upsert, no network fetch, so doing it inline keeps
          // subscribe fast without the async round-trip through the
          // worker. Falls back to enqueueing if anything here fails,
          // including an import that committed only some batches.
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
          } catch {
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

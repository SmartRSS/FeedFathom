import {
  articlesDataService,
  feedParser,
  feedPreviewCache,
  sourceEnqueuer,
  sourcesDataService,
  userSourcesDataService,
} from "#features/feeds/services.ts";
import { config } from "#platform/config.ts";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import {
  normalizedSubscriptionTarget,
  type SubscriptionTarget,
} from "#shared/validation/typebox-policy.ts";
import type { subscribeRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { outboundFetchBudget } from "#features/auth/services.ts";
import { json } from "#platform/http/json.ts";
import {
  deserializeFeedPreview,
  serializeFeedPreview,
} from "#features/feeds/feed-preview-cache.ts";

// Elysia's body-schema validation decodes Codec fields (e.g. sourceUrl's
// string -> {kind,value} transform) in some environments but not others, so
// this normalizes either shape rather than depending on that being decoded
// already.
function decodedSubscriptionTarget(
  value: SubscriptionTarget | string,
): SubscriptionTarget {
  return typeof value === "string"
    ? Value.Decode(normalizedSubscriptionTarget, value)
    : value;
}

export async function postSubscribeHandler({
  body,
  request,
  user,
}: {
  body: Omit<Static<typeof subscribeRequest>, "sourceUrl"> & {
    sourceUrl: SubscriptionTarget | string;
  };
  request: Request;
  user: AuthedUser;
}) {
  // Counted before any outbound work, including a cache hit: the budget is
  // about how often a user can ask us to reach out at all.
  await outboundFetchBudget.consume(user.id);
  const sourceUrl = decodedSubscriptionTarget(body.sourceUrl);
  const isEmail = sourceUrl.kind === "email";
  if (!config.MAIL_ENABLED && isEmail)
    return json({ error: "Email subscriptions are not allowed." }, 400);
  let homeUrl = new URL(request.url).origin;
  const cachedPreview = isEmail
    ? undefined
    : await feedPreviewCache.get(user.id, sourceUrl.value);
  if (cachedPreview?.link) homeUrl = cachedPreview.link;
  // A truncated preview holds only a sample of the feed, so the worker
  // fetches and imports the complete feed instead.
  const importablePreview = cachedPreview?.truncated
    ? undefined
    : cachedPreview;
  const subscription = await userSourcesDataService.addSourceToUser(user.id, {
    homeUrl,
    initializationSnapshot: importablePreview
      ? serializeFeedPreview(importablePreview)
      : null,
    kind: isEmail ? "email" : "feed",
    name: body.sourceName,
    parentId: body.sourceFolder,
    url: sourceUrl.value,
  });
  if (!subscription) return json({ error: "Invalid folder" }, 400);
  if (subscription.initialized === true)
    return json({ sourceId: subscription.source.id });

  const preview =
    subscription.initializationSnapshot === null
      ? undefined
      : subscription.initializationSnapshot === undefined
        ? importablePreview
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
  // finishes, the next parseSource poll re-discovers the hub, and
  // claimWebSubSubscribeAttempt keeps that retry from double-subscribing.
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
          // worker. Falls back to enqueueing if anything here fails.
          try {
            // batchUpsertArticles processes batches sequentially and a
            // later batch can fail after earlier ones already
            // committed -- recompute regardless of that outcome so
            // committed articles aren't left counted as unread-stale,
            // then let the original failure fall through to the
            // enqueue fallback below.
            let upsertError: unknown;
            try {
              await articlesDataService.batchUpsertArticles(
                preview.articles.map((article) => ({
                  author: article.author,
                  content: article.content,
                  guid: article.guid,
                  lastSeenInFeedAt: subscription.subscriptionCreatedAt,
                  publishedAt: article.publishedAt,
                  sourceId: subscription.source.id,
                  title: article.title,
                  updatedAt:
                    article.updatedAt === undefined
                      ? article.publishedAt
                      : article.updatedAt,
                  url: article.url,
                })),
              );
            } catch (error) {
              upsertError = error;
            }
            await userSourcesDataService.recomputeUnreadCounts([
              subscription.source.id,
            ]);
            if (upsertError !== undefined) {
              throw upsertError;
            }
            await sourcesDataService.successSource(
              subscription.source.id,
              true,
              new Date(preview.freshUntil ?? Date.now() + 5 * 60_000),
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
    return json({ error: "Subscription initialization in progress" }, 409);

  return json({ sourceId: subscription.source.id });
}

import type { Static } from "typebox";
import { Value } from "typebox/value";
import { subscribeRequest } from "../../contracts/requests.ts";
import type { ArticlesDataService } from "../../db/data-services/article-data-service.ts";
import type { SourcesDataService } from "../../db/data-services/source-data-service.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import {
  deserializeFeedPreview,
  type FeedPreviewCache,
  serializeFeedPreview,
} from "../../lib/feed-preview-cache.ts";
import {
  normalizedSubscriptionTarget,
  type SubscriptionTarget,
} from "../../lib/typebox-policy.ts";
import { type AuthedUser, json } from "../shared.ts";

export type SubscribeRouteDependencies = {
  articlesDataService: Pick<ArticlesDataService, "batchUpsertArticles">;
  feedPreviewCache: Pick<FeedPreviewCache, "get">;
  mailEnabled: boolean;
  sourcesDataService: Pick<SourcesDataService, "enqueueSource" | "successSource">;
  userSourcesDataService: Pick<
    UserSourcesDataService,
    "addSourceToUser" | "recomputeUnreadCounts"
  > &
    Partial<
      Pick<
        UserSourcesDataService,
        | "claimSubscriptionInitialization"
        | "completeSubscriptionInitialization"
        | "releaseSubscriptionInitialization"
      >
    >;
};

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

export async function postSubscribeHandler(
  {
    body,
    request,
    user,
  }: {
    body: Omit<Static<typeof subscribeRequest>, "sourceUrl"> & {
      sourceUrl: SubscriptionTarget | string;
    };
    request: Request;
    user: AuthedUser;
  },
  {
    articlesDataService,
    feedPreviewCache,
    mailEnabled,
    sourcesDataService,
    userSourcesDataService,
  }: SubscribeRouteDependencies,
) {
  const sourceUrl = decodedSubscriptionTarget(body.sourceUrl);
  const isEmail = sourceUrl.kind === "email";
  if (!mailEnabled && isEmail)
    return json({ error: "Email subscriptions are not allowed." }, 400);
  let homeUrl = new URL(request.url).origin;
  const cachedPreview = isEmail
    ? undefined
    : await feedPreviewCache.get(user.id, sourceUrl.value);
  if (cachedPreview?.link) homeUrl = cachedPreview.link;
  const subscription = await userSourcesDataService.addSourceToUser(
    user.id,
    {
      homeUrl,
      initializationSnapshot: cachedPreview
        ? serializeFeedPreview(cachedPreview)
        : null,
      name: body.sourceName,
      parentId: body.sourceFolder,
      url: sourceUrl.value,
    },
    false,
  );
  if (!subscription) return json({ error: "Invalid folder" }, 400);
  if (subscription.initialized === true)
    return json({ sourceId: subscription.source.id });

  const subscriptionId = subscription.subscriptionId;
  const claimed =
    subscriptionId === undefined ||
    userSourcesDataService.claimSubscriptionInitialization === undefined
      ? true
      : await userSourcesDataService.claimSubscriptionInitialization(
          subscriptionId,
        );
  if (!claimed)
    return json({ error: "Subscription initialization in progress" }, 409);

  const preview =
    subscription.initializationSnapshot === null
      ? undefined
      : subscription.initializationSnapshot === undefined
        ? cachedPreview
        : deserializeFeedPreview(
            subscription.initializationSnapshot,
            sourceUrl.value,
          );
  if (subscription.initializationSnapshot && !preview) {
    if (subscriptionId !== undefined && claimed !== true)
      await userSourcesDataService.releaseSubscriptionInitialization?.(
        subscriptionId,
        claimed,
      );
    throw new Error("Stored subscription snapshot is invalid");
  }

  try {
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
        await sourcesDataService.enqueueSource(subscription.source);
      }
    } else {
      await sourcesDataService.enqueueSource(subscription.source);
    }
    if (subscriptionId !== undefined && claimed !== true) {
      const completed =
        await userSourcesDataService.completeSubscriptionInitialization?.(
          subscriptionId,
          claimed,
        );
      if (completed === false)
        throw new Error("Subscription initialization lease expired");
    }
  } catch (error) {
    if (subscriptionId !== undefined && claimed !== true)
      await userSourcesDataService.releaseSubscriptionInitialization?.(
        subscriptionId,
        claimed,
      );
    throw error;
  }

  return json({ sourceId: subscription.source.id });
}

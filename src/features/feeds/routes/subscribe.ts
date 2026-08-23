import type { Static } from "typebox";
import { Value } from "typebox/value";
import {
  normalizedSubscriptionTarget,
  type SubscriptionTarget,
} from "#shared/validation/typebox-policy.ts";
import type { subscribeRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import {
  deserializeFeedPreview,
  type FeedPreviewCache,
  serializeFeedPreview,
} from "#features/feeds/feed-preview-cache.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";

export type SubscribeRouteDependencies = {
  articlesDataService: Pick<ArticlesDataService, "batchUpsertArticles">;
  feedParser: Pick<FeedParser, "discoverAndSubscribeWebSub">;
  feedPreviewCache: Pick<FeedPreviewCache, "get">;
  mailEnabled: boolean;
  sourcesDataService: Pick<
    SourcesDataService,
    "enqueueSource" | "successSource"
  >;
  userSourcesDataService: Pick<
    UserSourcesDataService,
    | "addSourceToUser"
    | "recomputeUnreadCounts"
    | "withSubscriptionInitializationLease"
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
    feedParser,
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
  const subscription = await userSourcesDataService.addSourceToUser(user.id, {
    homeUrl,
    initializationSnapshot: cachedPreview
      ? serializeFeedPreview(cachedPreview)
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
        ? cachedPreview
        : deserializeFeedPreview(
            subscription.initializationSnapshot,
            sourceUrl.value,
          );
  if (subscription.initializationSnapshot && !preview) {
    throw new Error("Stored subscription snapshot is invalid");
  }

  // Runs alongside (not before) the article-fetch lease below rather than
  // waiting on it -- both make their own network calls, so doing them
  // concurrently keeps this from adding two round trips' worth of latency
  // to what's otherwise a synchronous, user-facing subscribe request.
  const websubDiscovery = isEmail
    ? Promise.resolve()
    : feedParser.discoverAndSubscribeWebSub(
        subscription.source.id,
        sourceUrl.value,
        subscription.source.websubStatus,
      );

  const [, lease] = await Promise.all([
    websubDiscovery,
    userSourcesDataService.withSubscriptionInitializationLease(
      subscription.subscriptionId,
      async () => {
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
      },
    ),
  ]);
  if (lease.outcome === "in-progress")
    return json({ error: "Subscription initialization in progress" }, 409);

  return json({ sourceId: subscription.source.id });
}

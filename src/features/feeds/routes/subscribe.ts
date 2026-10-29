import type * as feeds from "#features/feeds/services.ts";
import type * as auth from "#features/auth/services.ts";
import type { AppConfig } from "#platform/config.ts";
import type { StaticDecode } from "typebox";
import type { subscribeRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import {
  deserializeFeedPreview,
  serializeFeedPreview,
} from "#features/feeds/feed-preview-cache.ts";
import {
  type FeedPreview,
  mapFeedToPreviewArticles,
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
    articles: mapFeedToPreviewArticles(feed, preview.feedUrl, {
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
    sourcesDataService,
    userSourcesDataService,
  }: Pick<typeof auth, "outboundFetchBudget"> &
    Pick<
      typeof feeds,
      | "articleImporter"
      | "feedParser"
      | "feedPreviewCache"
      | "sourceEnqueuer"
      | "sourcesDataService"
      | "userSourcesDataService"
    > & { config: AppConfig },
) {
  // Counted before any outbound work, including a cache hit: the budget is
  // about how often a user can ask us to reach out at all.
  await outboundFetchBudget.consume(user.id);
  const { sourceUrl } = body;
  const isEmail = sourceUrl.kind === "email";
  if (!config.MAIL_ENABLED && isEmail)
    return json({ error: "Email subscriptions are not allowed." }, 400);
  let homeUrl = new URL(request.url).origin;
  const cachedPreview = isEmail
    ? undefined
    : await feedPreviewCache.get(user.id, sourceUrl.value);
  if (cachedPreview?.link) homeUrl = cachedPreview.link;
  const importablePreview = cachedPreview && completePreview(cachedPreview);
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
            // A retry imports from the stored snapshot, which can hold an
            // alert that has expired since.
            const now = Date.now();
            await articleImporter.importArticles(
              subscription.source.id,
              preview.articles
                .filter(
                  (article) =>
                    article.expiresAt === undefined || article.expiresAt > now,
                )
                .map(({ expiresAt: _expiresAt, ...article }) =>
                  Object.assign(article, {
                    lastSeenInFeedAt: subscription.subscriptionCreatedAt,
                  }),
                ),
              { alwaysRecount: true },
            );
            await sourcesDataService.successSource(
              subscription.source.id,
              true,
              preview.freshUntil ? new Date(preview.freshUntil) : undefined,
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

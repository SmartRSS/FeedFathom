import { Elysia } from "elysia";
import { Value } from "typebox/value";
import {
  normalizedSubscriptionTarget,
  type SubscriptionTarget,
} from "../lib/typebox-policy.ts";
import {
  articleQuery,
  articlesRequest,
  createFolderRequest,
  findQuery,
  previewQuery,
  removeArticlesRequest,
  removeFolderRequest,
  removeSourceRequest,
  subscribeRequest,
} from "../contracts/requests.ts";
import type { ArticlesDataService } from "../db/data-services/article-data-service.ts";
import type { FoldersDataService } from "../db/data-services/folder-data-service.ts";
import type { SourcesDataService } from "../db/data-services/source-data-service.ts";
import type { UserSourcesDataService } from "../db/data-services/user-source-data-service.ts";
import type { UsersDataService } from "../db/data-services/user-data-service.ts";
import { extractArticle } from "../lib/extract-article.ts";
import { safeArticleUrl } from "../lib/feed-mapper.ts";
import type { FeedParser } from "../lib/feed-parser.ts";
import {
  type FeedPreviewCache,
  serializeFeedPreview,
} from "../lib/feed-preview-cache.ts";
import { scanHtml } from "../lib/scanner.ts";
import { json, userFor } from "./shared.ts";

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

export type ReaderRouteDependencies = {
  articlesDataService: Pick<
    ArticlesDataService,
    "getUserArticle" | "getUserArticlesForSources" | "removeUserArticles"
  >;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
  feedParser: Pick<FeedParser, "preview">;
  feedPreviewCache: Pick<FeedPreviewCache, "get" | "save">;
  foldersDataService: Pick<
    FoldersDataService,
    "createFolder" | "getUserFolders" | "removeEmptyUserFolder"
  >;
  httpClient: {
    get(url: string): Promise<{ data: string }>;
  };
  mailEnabled: boolean;
  sourcesDataService: Pick<SourcesDataService, "enqueueSource" | "getFavicon">;
  userSourcesDataService: Pick<
    UserSourcesDataService,
    | "addSourceToUser"
    | "getUserSources"
    | "recomputeUnreadCountsForUser"
    | "removeSourceFromUser"
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

export const createReaderRoutes = ({
  articlesDataService,
  feedParser,
  feedPreviewCache,
  foldersDataService,
  httpClient,
  mailEnabled,
  sourcesDataService,
  usersDataService,
  userSourcesDataService,
}: ReaderRouteDependencies) =>
  new Elysia()
    .derive(async ({ cookie, status }) => {
      const user = await userFor(cookie["sid"]?.value, usersDataService);
      return user ? { user } : status(401, { error: "Unauthorized" });
    })
    .get("/api/tree", async ({ user }) => {
      const [sources, folders] = await Promise.all([
        userSourcesDataService.getUserSources(user.id),
        foldersDataService.getUserFolders(user.id),
      ]);
      const children = new Map<number, unknown[]>();
      const roots: unknown[] = [];
      for (const source of sources) {
        const item = {
          favicon: `/api/favicon/${source.id}`,
          homeUrl: source.homeUrl ?? "",
          name: source.name,
          type: "source",
          uid: source.id?.toString() ?? "",
          unreadCount: source.unreadArticlesCount,
          xmlUrl: source.url ?? "",
        };
        if (source.parentId)
          children.set(source.parentId, [
            ...(children.get(source.parentId) ?? []),
            item,
          ]);
        else roots.push(item);
      }
      return json({
        tree: [
          ...folders.map((folder) => ({
            children: children.get(folder.id) ?? [],
            name: folder.name,
            type: "folder",
            uid: folder.id.toString(),
          })),
          ...roots,
        ],
      });
    })
    .get("/api/favicon/:id", async ({ params, status }) => {
      const sourceId = Number(params.id);
      const dataUrl = Number.isInteger(sourceId)
        ? await sourcesDataService.getFavicon(sourceId)
        : null;
      const match = dataUrl ? /^data:([^;]+);base64,(.+)$/.exec(dataUrl) : null;
      if (!match) return status(404);
      return new Response(Buffer.from(match[2] ?? "", "base64"), {
        headers: {
          "Cache-Control": "public, max-age=86400",
          "Content-Type": match[1] ?? "application/octet-stream",
        },
      });
    })
    .post(
      "/api/articles",
      { body: articlesRequest },
      async ({ body, request, user }) => {
        if (!body.sources.length) return json([]);
        const articles = await articlesDataService.getUserArticlesForSources(
          body.sources,
          user.id,
        );
        return json(
          articles.map((article) =>
            Object.assign(article, {
              url: safeArticleUrl(article.url, request.url),
            }),
          ),
        );
      },
    )
    .delete(
      "/api/articles",
      { body: removeArticlesRequest },
      async ({ body, user }) => {
        const affectedSourceIds = await articlesDataService.removeUserArticles(
          body.removedArticleIdList,
          user.id,
        );
        await userSourcesDataService.recomputeUnreadCountsForUser(
          user.id,
          affectedSourceIds,
        );
        return json(body.removedArticleIdList);
      },
    )
    .get("/api/folders", async ({ user }) =>
      json(await foldersDataService.getUserFolders(user.id)),
    )
    .post(
      "/api/folders",
      { body: createFolderRequest },
      async ({ body, user }) => {
        // Elysia 2.0-beta validates body shape but doesn't run Codec .Decode()
        // transforms, so normalized*() fields arrive undecoded; decode by hand.
        const decoded = Value.Decode(createFolderRequest, body);
        return json(
          await foldersDataService.createFolder(user.id, decoded.name),
        );
      },
    )
    .delete(
      "/api/folders",
      { body: removeFolderRequest },
      async ({ body, user }) => {
        if (
          !(await foldersDataService.removeEmptyUserFolder(
            user.id,
            body.removeFolderId,
          ))
        )
          return json({ error: "Folder is not empty" }, 409);
        return json(body.removeFolderId);
      },
    )
    .delete(
      "/api/source",
      { body: removeSourceRequest },
      async ({ body, user }) => {
        await userSourcesDataService.removeSourceFromUser(
          user.id,
          body.removeSourceId,
        );
        return json(body.removeSourceId);
      },
    )
    .get("/api/preview", { query: previewQuery }, async ({ query, user }) => {
      const decoded = Value.Decode(previewQuery, query);
      const source = await feedParser.preview(decoded.feedUrl);
      if (!source) return json({ error: "Invalid feed url" }, 400);
      await feedPreviewCache.save(user.id, decoded.feedUrl, source);
      return json({
        articles: await Promise.all(
          source.articles.map(async (article) => ({
            author: article.author,
            content: extractArticle(article.content),
            publishedAt: article.publishedAt,
            title: article.title,
            url: article.url,
          })),
        ),
        description: source.description,
        feedUrl: source.feedUrl,
        link: source.link,
        title: source.title,
      });
    })
    .get("/api/find", { query: findQuery }, async ({ query }) => {
      const decoded = Value.Decode(findQuery, query);
      try {
        const response = await httpClient.get(decoded.link);
        const feeds = scanHtml(decoded.link, response.data);
        return feeds.length
          ? json(feeds)
          : json({ error: "Invalid feed url" }, 400);
      } catch {
        return json({ error: "Invalid feed url" }, 400);
      }
    })
    .get(
      "/api/article",
      { query: articleQuery },
      async ({ query, request, user }) => {
        const decoded = Value.Decode(articleQuery, query);
        const article = await articlesDataService.getUserArticle(
          decoded.article,
          user.id,
        );
        if (!article) return json({}, 404);
        return json({
          ...article,
          content: extractArticle(article.content),
          url: safeArticleUrl(article.url, request.url),
        });
      },
    )
    .post(
      "/api/subscribe",
      { body: subscribeRequest },
      async ({ body, request, user }) => {
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
          return json(
            { error: "Subscription initialization in progress" },
            409,
          );

        try {
          // Always hand off to the worker, even when a cached preview is
          // available: ingesting it inline here would mean doing synchronous
          // article upserts + unread-count recomputation in the
          // request/response cycle, and it previously skipped the recompute
          // entirely, leaving newly subscribed sources stuck at "0 unread"
          // until their next scheduled poll. The worker's `parseSource`
          // already does upsert + recompute + successSource correctly (see
          // feed-parser.ts), so route both the cache-hit and cache-miss
          // cases through the same `enqueueSource` path and let it run
          // off-request.
          await sourcesDataService.enqueueSource(subscription.source);
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
      },
    );

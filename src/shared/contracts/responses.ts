import { Type, type Static } from "typebox";
import { jsonDatePolicy } from "#shared/validation/typebox-policy.ts";

const exact = { additionalProperties: false } as const;
const id = Type.Integer({ minimum: 1 });
const jsonDate = jsonDatePolicy;

export const successResponse = Type.Object(
  { success: Type.Literal(true) },
  exact,
);

export const loginResponse = Type.Object({ sid: Type.String() }, exact);

const sessionUser = Type.Object(
  {
    email: Type.String(),
    id,
    isAdmin: Type.Boolean(),
    name: Type.String(),
    status: Type.Union([Type.Literal("active"), Type.Literal("inactive")]),
  },
  exact,
);
export const sessionResponse = Type.Object(
  {
    // Present only where mail ingest is configured: the host newsletter
    // addresses are minted at, and the SPA's only signal that email
    // subscriptions are accepted at all.
    mailDomain: Type.Optional(Type.String()),
    user: Type.Union([sessionUser, Type.Null()]),
  },
  exact,
);

export const registrationResponse = Type.Object(
  {
    registrationStatus: Type.Union([
      Type.Literal("FIRST_USER"),
      Type.Literal("ENABLED"),
      Type.Literal("DISABLED"),
    ]),
    turnstileSiteKey: Type.Union([Type.String(), Type.Null()]),
  },
  exact,
);

const treeNodeResponse = Type.Cyclic(
  {
    treeNode: Type.Union([
      Type.Object(
        {
          children: Type.Array(Type.Ref("treeNode")),
          name: Type.String(),
          type: Type.Literal("folder"),
          uid: Type.String(),
        },
        exact,
      ),
      Type.Object(
        {
          favicon: Type.Union([Type.String(), Type.Null()]),
          homeUrl: Type.String(),
          kind: Type.Union([
            Type.Literal("email"),
            Type.Literal("feed"),
            Type.Literal("websub"),
          ]),
          name: Type.String(),
          type: Type.Literal("source"),
          uid: Type.String(),
          unreadCount: Type.Number(),
          xmlUrl: Type.String(),
        },
        exact,
      ),
    ]),
  },
  "treeNode",
);
export const treeResponse = Type.Object(
  { tree: Type.Array(treeNodeResponse) },
  exact,
);

const articleSummaryResponse = Type.Object(
  {
    author: Type.String(),
    group: Type.String(),
    id,
    publishedAt: jsonDate,
    sourceId: id,
    title: Type.String(),
    url: Type.String(),
  },
  exact,
);
export const articlesResponse = Type.Array(articleSummaryResponse);

export const articleResponse = Type.Object(
  {
    author: Type.String(),
    content: Type.String(),
    guid: Type.String(),
    id,
    lastSeenInFeedAt: jsonDate,
    publishedAt: jsonDate,
    sourceId: id,
    title: Type.String(),
    updatedAt: Type.Union([jsonDate, Type.Null()]),
    url: Type.String(),
  },
  exact,
);

export const folderResponse = Type.Object(
  {
    createdAt: jsonDate,
    id,
    name: Type.String(),
    updatedAt: jsonDate,
    userId: id,
  },
  exact,
);
export const foldersResponse = Type.Array(folderResponse);

export const foundFeedsResponse = Type.Array(
  Type.Object(
    { title: Type.String(), url: Type.String(), websub: Type.Boolean() },
    exact,
  ),
);

const previewArticleResponse = Type.Object(
  {
    author: Type.String(),
    content: Type.String(),
    publishedAt: jsonDate,
    title: Type.String(),
    url: Type.String(),
  },
  exact,
);
export const previewResponse = Type.Object(
  {
    articles: Type.Array(previewArticleResponse),
    description: Type.Optional(Type.String()),
    feedUrl: Type.String(),
    link: Type.Optional(Type.String()),
    title: Type.String(),
  },
  exact,
);

export const subscriptionResponse = Type.Object({ sourceId: id }, exact);
export const removedArticlesResponse = Type.Array(id);
export const removedIdResponse = id;
export const updatedSourceResponse = Type.Object({ sourceId: id }, exact);
export const updatedFolderResponse = Type.Object({ folderId: id }, exact);

export const adminSourcesResponse = Type.Array(
  Type.Object(
    {
      createdAt: jsonDate,
      homeUrl: Type.String(),
      id,
      lastAttempt: Type.Union([jsonDate, Type.Null()]),
      lastFetchTrigger: Type.Union([
        Type.Literal("email"),
        Type.Literal("manual"),
        Type.Literal("poll"),
        Type.Literal("websub-push"),
        Type.Null(),
      ]),
      lastSuccess: Type.Union([jsonDate, Type.Null()]),
      recentFailureDetails: Type.String(),
      recentFailures: Type.Integer({ minimum: 0 }),
      subscriberCount: Type.Integer({ minimum: 0 }),
      url: Type.String(),
      websubStatus: Type.Union([
        Type.Literal("none"),
        Type.Literal("pending"),
        Type.Literal("verified"),
        Type.Literal("failed"),
      ]),
    },
    exact,
  ),
);

export type Article = Static<typeof articleResponse>;
export type ArticleSummary = Static<typeof articleSummaryResponse>;
export type Folder = Static<typeof folderResponse>;
export type FoundFeed = Static<typeof foundFeedsResponse>[number];
export type PreviewArticle = Static<typeof previewArticleResponse>;
export type Registration = Static<typeof registrationResponse>;
export type TreeNode = Static<typeof treeNodeResponse>;

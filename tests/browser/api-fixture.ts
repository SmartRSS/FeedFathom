import {
  expect,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import type { Static, StaticEncode, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  articlesRequest,
  createFolderRequest,
  loginRequest,
  newsletterAddressRequest,
  readArticlesRequest,
  removeArticlesRequest,
  removeFolderRequest,
  removeSourceRequest,
  subscribeRequest,
  updateFolderRequest,
  updateSourceRequest,
} from "#shared/contracts/requests.ts";
import {
  adminSourcesResponse,
  articleResponse,
  articlesResponse,
  errorResponse,
  folderResponse,
  foldersResponse,
  foundFeedsResponse,
  previewResponse,
  registrationResponse,
  removedArticlesResponse,
  removedIdResponse,
  sessionResponse,
  sessionsResponse,
  subscriptionResponse,
  successResponse,
  treeResponse,
  updatedFolderResponse,
  updatedSourceResponse,
  type Article,
  type ArticleSummary,
  type TreeNode,
} from "#shared/contracts/responses.ts";
import { invalidRequestMessage } from "#platform/http/json.ts";

// Answers as the server does: the body is checked against the contract the
// SPA decodes it with, at lint time and again when the test runs, since a
// spread escapes TypeScript's excess-property check and the contracts are
// exact.
export function respond<S extends TSchema>(
  route: Route,
  schema: S,
  body: StaticEncode<S>,
  status = 200,
) {
  if (!Value.Check(schema, body)) {
    const issue = Value.Errors(schema, body)[0];
    throw new Error(
      `Fixture answer to ${route.request().url()} breaks its contract: ${issue?.instancePath} ${issue?.message}`,
    );
  }
  return route.fulfill({ json: body, status });
}

export const refuse = (route: Route, status: number, error: string) =>
  respond(route, errorResponse, { error }, status);

// An answer that breaks the contract on purpose, to test how the SPA takes it.
export const malformed = (route: Route, body: unknown) =>
  route.fulfill({ json: body });

type SessionUser = NonNullable<Static<typeof sessionResponse>["user"]>;
type SessionEntry = Static<typeof sessionsResponse>["sessions"][number];

const user = {
  email: "reader@example.com",
  id: 42,
  isAdmin: false,
  name: "Reader",
  status: "active",
} satisfies SessionUser;

const source = {
  favicon: null,
  homeUrl: "https://news.example/",
  kind: "feed",
  name: "Tech News",
  type: "source",
  uid: "3",
  unreadCount: 2,
  xmlUrl: "https://news.example/feed.xml",
} satisfies TreeNode;

const subscribedSource = {
  favicon: null,
  homeUrl: "https://preview.example/",
  kind: "feed",
  name: "Tech Preview",
  type: "source",
  uid: "9",
  unreadCount: 1,
  xmlUrl: "https://preview.example/feed.xml",
} satisfies TreeNode;

const article = {
  author: "News Author",
  content: "<p>Feed article content</p>",
  guid: "article-11",
  id: 11,
  lastSeenInFeedAt: "2026-07-20T12:00:00.000Z",
  publishedAt: "2026-07-20T11:00:00.000Z",
  sourceId: 3,
  title: "First article",
  updatedAt: null,
  url: "https://articles.example/first",
} satisfies Article;

// Two more Tech News articles alongside `article`, only returned when
// `multipleArticles` is on -- exercises select-all/multi-delete without
// changing the article count every other existing test already asserts
// against (several match on "First article" as if it may be the only row).
const secondArticle = {
  ...article,
  guid: "article-12",
  id: 12,
  title: "Second article",
  url: "https://articles.example/second",
};
const thirdArticle = {
  ...article,
  guid: "article-13",
  id: 13,
  title: "Third article",
  url: "https://articles.example/third",
};

// Tall enough to scroll the reader pane well past one viewport (#718).
const longContent = Array.from(
  { length: 300 },
  (_, index) => `<p>Paragraph ${index} of a very long article.</p>`,
).join("");

// A first page worth of rows, so the article list overflows and a scroll
// position exists to restore (#718).
const manyArticles = Array.from({ length: 60 }, (_, index) => ({
  ...article,
  guid: `article-${100 + index}`,
  id: 100 + index,
  title: `Article ${100 + index}`,
  url: `https://articles.example/${100 + index}`,
}));

const subscribedArticle = {
  author: "Preview Author",
  content: "<p>Subscribed feed content</p>",
  guid: "article-19",
  id: 19,
  lastSeenInFeedAt: "2026-07-21T12:00:00.000Z",
  publishedAt: "2026-07-21T11:00:00.000Z",
  sourceId: 9,
  title: "Subscribed article",
  updatedAt: null,
  url: "https://articles.example/subscribed",
} satisfies Article;

// The confirmation mail a newsletter sends to a minted address, which can
// arrive before the user subscribes to it (#1116).
const newsletterArticle = {
  author: "editor@letters.example",
  content: "<p>Confirm your subscription</p>",
  guid: "article-21",
  id: 21,
  lastSeenInFeedAt: "2026-07-22T12:00:00.000Z",
  publishedAt: "2026-07-22T11:00:00.000Z",
  sourceId: 21,
  title: "Confirm your subscription",
  updatedAt: null,
  // Newsletter articles have no page of their own (safeArticleUrl).
  url: "",
} satisfies Article;

const summary = (item: Article, read = false): ArticleSummary => ({
  author: item.author,
  id: item.id,
  publishedAt: item.publishedAt,
  read,
  sourceId: item.sourceId,
  title: item.title,
  url: item.url,
});

type ApiFixtureState = {
  articleRequests: number;
  authenticated: boolean;
  // Mail to a newsletter address, answered as the server would: accepted
  // only once the address has been reserved.
  deliverNewsletter: (to: string) => boolean;
  // While set, POST /api/newsletter-address fails as an outage would.
  failReservations: boolean;
  newsletterDelivered: boolean;
  newsletterSubscription: string | undefined;
  reservedAddresses: string[];
  // One entry per PATCH /api/articles: the articleIdList it carried, so the
  // mark-as-read policy tests can count requests and check batching (#714).
  readMarks: number[][];
  readArticleIds: Set<number>;
  findRequests: number;
  // With discoveryRace, the slow.xml preview is held until this is called.
  releaseSlowPreview: () => void;
  removedArticleIds: number[];
  removedFolderIds: number[];
  removedSourceIds: number[];
  revokedSessionIds: number[];
  revokedOtherSessions: boolean;
  subscribed: boolean;
  subscriptionBodies: object[];
  treeRequests: number;
  updatedFolder: { name: string } | undefined;
  updatedSource: { name: string; parentId: null | number } | undefined;
};

export async function installApiFixture(
  // A context also routes what a controlling service worker fetches.
  page: BrowserContext | Page,
  options: {
    admin?: boolean;
    authenticated?: boolean;
    discoveryRace?: boolean;
    // A second folder, "Later", with nothing in it.
    emptyFolder?: boolean;
    notAdmin?: boolean;
    // Tech News keeps failing with this reason, its last success that long
    // ago; its articles stay.
    failing?: { daysSinceSuccess: number; reason: string };
    folderCreateFailure?: boolean;
    foldersFailure?: boolean;
    longArticle?: boolean;
    mailDomain?: string;
    manyArticles?: boolean;
    multipleArticles?: boolean;
    passwordResetEnabled?: boolean;
    previewTruncated?: boolean;
    sessionFailure?: boolean;
    treeFailure?: boolean;
    websubFeed?: boolean;
  } = {},
): Promise<ApiFixtureState> {
  const slowPreview = Promise.withResolvers<void>();
  const state: ApiFixtureState = {
    articleRequests: 0,
    authenticated: options.authenticated ?? true,
    deliverNewsletter: (to) => {
      state.newsletterDelivered = state.reservedAddresses.includes(to);
      return state.newsletterDelivered;
    },
    failReservations: false,
    findRequests: 0,
    newsletterDelivered: false,
    newsletterSubscription: undefined,
    readArticleIds: new Set<number>(),
    readMarks: [],
    releaseSlowPreview: () => slowPreview.resolve(),
    removedArticleIds: [],
    removedFolderIds: [],
    removedSourceIds: [],
    reservedAddresses: [],
    revokedOtherSessions: false,
    revokedSessionIds: [],
    subscribed: false,
    subscriptionBodies: [],
    treeRequests: 0,
    updatedFolder: undefined,
    updatedSource: undefined,
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === "GET" && url.pathname === "/api/session") {
      if (options.sessionFailure)
        return malformed(route, { user: { id: "malformed" } });
      return respond(route, sessionResponse, {
        ...(options.mailDomain ? { mailDomain: options.mailDomain } : {}),
        user: state.authenticated
          ? { ...user, isAdmin: options.admin ?? false }
          : null,
      });
    }

    // The login view reads this to decide whether to offer a reset link, so
    // it is fetched on every visit to /login, not just on the register page.
    if (method === "GET" && url.pathname === "/api/register") {
      return respond(route, registrationResponse, {
        passwordResetEnabled: options.passwordResetEnabled ?? false,
        registrationStatus: "DISABLED",
        turnstileSiteKey: null,
      });
    }

    if (method === "POST" && url.pathname === "/api/login") {
      expect(Value.Parse(loginRequest, request.postDataJSON())).toEqual({
        email: "reader@example.com",
        password: "password",
      });
      state.authenticated = true;
      return respond(route, successResponse, { success: true });
    }

    if (method === "POST" && url.pathname === "/api/logout") {
      state.authenticated = false;
      return respond(route, successResponse, { success: true });
    }

    // Two sessions for the signed-in account: id 1 stands in for the
    // browser making the request, id 2 for a second device. Revocations
    // update the list, so the options page can be asserted to shrink.
    if (method === "GET" && url.pathname === "/api/options/sessions") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      const sessions: SessionEntry[] = [
        {
          createdAt: "2026-09-08T00:00:00.000Z",
          current: true,
          expiresAt: "2027-09-08T00:00:00.000Z",
          id: 1,
          lastUsedAt: "2026-09-08T12:00:00.000Z",
          userAgent: "This browser",
        },
        {
          createdAt: "2026-09-01T00:00:00.000Z",
          current: false,
          expiresAt: "2027-09-01T00:00:00.000Z",
          id: 2,
          lastUsedAt: "2026-09-01T12:00:00.000Z",
          userAgent: "Phone",
        },
      ].filter(
        (session) =>
          !state.revokedSessionIds.includes(session.id) &&
          !(state.revokedOtherSessions && !session.current),
      );
      return respond(route, sessionsResponse, { sessions });
    }

    // A change signs out every other session, as the server's does.
    if (method === "POST" && url.pathname === "/api/options/password") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      state.revokedOtherSessions = true;
      return respond(route, successResponse, { success: true });
    }

    if (method === "DELETE" && url.pathname === "/api/options/sessions") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      state.revokedOtherSessions = true;
      return respond(route, successResponse, { success: true });
    }

    if (
      method === "DELETE" &&
      url.pathname.startsWith("/api/options/sessions/")
    ) {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      const id = Number(url.pathname.slice("/api/options/sessions/".length));
      if (id === 1)
        return refuse(
          route,
          400,
          "The current session signs out via Logout instead.",
        );
      state.revokedSessionIds.push(id);
      return respond(route, successResponse, { success: true });
    }

    // 204 is the one answer EventSource never retries, so by default the
    // dashboard runs on its timer poll, as behind a proxy that eats streams.
    if (method === "GET" && url.pathname === "/api/events") {
      return route.fulfill({ status: 204 });
    }

    if (method === "GET" && url.pathname === "/api/tree") {
      state.treeRequests++;
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      if (options.treeFailure) return malformed(route, { tree: "malformed" });
      const currentSource = {
        ...source,
        ...(state.updatedSource ? { name: state.updatedSource.name } : {}),
        ...(options.failing
          ? {
              failing: {
                lastSuccess: new Date(
                  Date.now() - options.failing.daysSinceSuccess * 86_400_000,
                ).toJSON(),
                reason: options.failing.reason,
              },
            }
          : {}),
      };
      const reading: TreeNode[] = [];
      if (!state.removedSourceIds.includes(3)) reading.push(currentSource);
      if (state.subscribed && !state.removedSourceIds.includes(9))
        reading.push(subscribedSource);
      if (state.newsletterSubscription)
        reading.push({
          favicon: null,
          homeUrl: "http://127.0.0.1",
          kind: "email",
          name: "Letters",
          type: "source",
          uid: "21",
          unreadCount: state.newsletterDelivered ? 1 : 0,
          xmlUrl: state.newsletterSubscription,
        });
      const tree: TreeNode[] = [];
      if (!state.removedFolderIds.includes(7)) {
        tree.push({
          children: reading,
          name: state.updatedFolder?.name ?? "Reading",
          type: "folder",
          uid: "7",
        });
        if (options.emptyFolder)
          tree.push({ children: [], name: "Later", type: "folder", uid: "12" });
      }
      return respond(route, treeResponse, { tree });
    }

    if (method === "POST" && url.pathname === "/api/articles") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      state.articleRequests += 1;
      // Search (#697) is answered by Postgres full text in the real app; the
      // fixture only has to prove the client asked across subscriptions
      // rather than for the selected feed, so a title substring will do.
      const {
        filter = "unread",
        query,
        sources,
      } = Value.Parse(articlesRequest, request.postDataJSON());
      if (query) {
        const terms = query.toLowerCase();
        return respond(
          route,
          articlesResponse,
          [article, secondArticle, thirdArticle, subscribedArticle]
            .filter((item) => item.title.toLowerCase().includes(terms))
            .map((item) => summary(item, state.readArticleIds.has(item.id))),
        );
      }
      expect(sources.every((sourceId) => [3, 9, 21].includes(sourceId))).toBe(
        true,
      );
      if (sources.length === 1 && sources[0] === 21) {
        return respond(
          route,
          articlesResponse,
          state.newsletterDelivered ? [summary(newsletterArticle)] : [],
        );
      }
      if (sources.length === 1 && sources[0] === 9) {
        return respond(route, articlesResponse, [summary(subscribedArticle)]);
      }
      const techNewsArticles = options.manyArticles
        ? manyArticles
        : options.multipleArticles
          ? [article, secondArticle, thirdArticle]
          : options.longArticle
            ? [{ ...article, content: longContent }]
            : [article];
      return respond(
        route,
        articlesResponse,
        techNewsArticles
          .filter((item) => !state.removedArticleIds.includes(item.id))
          .filter((item) => {
            if (filter === "all") return true;
            const read = state.readArticleIds.has(item.id);
            return filter === "read" ? read : !read;
          })
          .map((item) => summary(item, state.readArticleIds.has(item.id))),
      );
    }

    if (method === "PATCH" && url.pathname === "/api/articles") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      const { articleIdList, read } = Value.Parse(
        readArticlesRequest,
        request.postDataJSON(),
      );
      state.readMarks.push(articleIdList);
      for (const id of articleIdList) {
        if (read) state.readArticleIds.add(id);
        else state.readArticleIds.delete(id);
      }
      return respond(route, removedArticlesResponse, articleIdList);
    }

    if (method === "DELETE" && url.pathname === "/api/articles") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      const { removedArticleIdList } = Value.Parse(
        removeArticlesRequest,
        request.postDataJSON(),
      );
      state.removedArticleIds.push(...removedArticleIdList);
      return respond(route, removedArticlesResponse, removedArticleIdList);
    }

    if (method === "GET" && url.pathname === "/api/article") {
      const id = url.searchParams.get("article");
      const numeric = Number(id);
      const fromMany =
        options.manyArticles === true &&
        Number.isInteger(numeric) &&
        numeric >= 100 &&
        numeric < 100 + manyArticles.length;
      if (fromMany) {
        const item = manyArticles[numeric - 100]!;
        return respond(route, articleResponse, {
          ...item,
          content: longContent,
        });
      }
      expect(["11", "12", "13", "19", "21"]).toContain(id);
      if (id === "19")
        return respond(route, articleResponse, subscribedArticle);
      if (id === "21")
        return respond(route, articleResponse, newsletterArticle);
      if (id === "12") return respond(route, articleResponse, secondArticle);
      if (id === "13") return respond(route, articleResponse, thirdArticle);
      return respond(
        route,
        articleResponse,
        options.longArticle ? { ...article, content: longContent } : article,
      );
    }

    if (method === "POST" && url.pathname === "/api/folders") {
      expect(Value.Parse(createFolderRequest, request.postDataJSON())).toEqual({
        name: "Saved",
      });
      if (options.folderCreateFailure)
        return malformed(route, { id: "malformed" });
      return respond(route, folderResponse, {
        createdAt: "2026-07-01T00:00:00.000Z",
        id: 8,
        name: "Saved",
        updatedAt: "2026-07-01T00:00:00.000Z",
        userId: 42,
      });
    }

    if (method === "DELETE" && url.pathname === "/api/source") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      const { removeSourceId } = Value.Parse(
        removeSourceRequest,
        request.postDataJSON(),
      );
      state.removedSourceIds.push(removeSourceId);
      return respond(route, removedIdResponse, removeSourceId);
    }

    if (method === "PATCH" && url.pathname === "/api/source") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      const { sourceFolder, sourceId, sourceName } = Value.Parse(
        updateSourceRequest,
        request.postDataJSON(),
      );
      expect(sourceId).toBe(3);
      state.updatedSource = { name: sourceName, parentId: sourceFolder };
      return respond(route, updatedSourceResponse, { sourceId });
    }

    if (method === "PATCH" && url.pathname === "/api/folders") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      const { folderId, folderName } = Value.Parse(
        updateFolderRequest,
        request.postDataJSON(),
      );
      expect(folderId).toBe(7);
      state.updatedFolder = { name: folderName };
      return respond(route, updatedFolderResponse, { folderId });
    }

    if (method === "DELETE" && url.pathname === "/api/folders") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      const { removeFolderId } = Value.Parse(
        removeFolderRequest,
        request.postDataJSON(),
      );
      state.removedFolderIds.push(removeFolderId);
      return respond(route, removedIdResponse, removeFolderId);
    }

    if (method === "GET" && url.pathname === "/api/folders") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      if (options.foldersFailure)
        return malformed(route, { folders: "malformed" });
      return respond(route, foldersResponse, [
        {
          createdAt: "2026-07-01T00:00:00.000Z",
          id: 7,
          name: "Reading",
          updatedAt: "2026-07-01T00:00:00.000Z",
          userId: 42,
        },
        ...(options.emptyFolder
          ? [
              {
                createdAt: "2026-07-01T00:00:00.000Z",
                id: 12,
                name: "Later",
                updatedAt: "2026-07-01T00:00:00.000Z",
                userId: 42,
              },
            ]
          : []),
      ]);
    }

    if (method === "GET" && url.pathname === "/api/find") {
      state.findRequests++;
      expect(url.searchParams.get("link")).toBe("https://preview.example/");
      return respond(
        route,
        foundFeedsResponse,
        options.discoveryRace
          ? [
              {
                title: "Slow feed",
                url: "https://preview.example/slow.xml",
                websub: false,
              },
              {
                title: "Fast feed",
                url: "https://preview.example/fast.xml",
                websub: false,
              },
            ]
          : [
              {
                title: "Tech Preview",
                url: "https://preview.example/feed.xml",
                websub: Boolean(options.websubFeed),
              },
            ],
      );
    }

    if (method === "GET" && url.pathname === "/api/preview") {
      const feedUrl = url.searchParams.get("feedUrl") ?? "";
      if (options.discoveryRace && feedUrl.endsWith("/slow.xml"))
        await slowPreview.promise;
      else if (!options.discoveryRace)
        expect(feedUrl).toBe("https://preview.example/feed.xml");
      const title = options.discoveryRace
        ? feedUrl.endsWith("/fast.xml")
          ? "Fast feed"
          : "Slow feed"
        : "Tech Preview";
      return respond(route, previewResponse, {
        articles: [
          {
            author: "Preview Author",
            content: "<p>Preview article content</p>",
            publishedAt: "2026-07-21T11:00:00.000Z",
            title: `${title} article`,
            url: "https://articles.example/preview",
          },
        ],
        description: "Preview description",
        feedUrl,
        link: "https://preview.example/",
        title,
        truncated: options.previewTruncated ?? false,
      });
    }

    if (method === "POST" && url.pathname === "/api/newsletter-address") {
      if (state.failReservations)
        return refuse(route, 500, "Internal server error");
      const { address } = Value.Parse(
        newsletterAddressRequest,
        request.postDataJSON(),
      );
      state.reservedAddresses.push(address);
      return respond(route, successResponse, { success: true });
    }

    if (method === "POST" && url.pathname === "/api/subscribe") {
      const body = Value.Parse(subscribeRequest, request.postDataJSON());
      if (state.reservedAddresses.includes(body.sourceUrl)) {
        state.subscriptionBodies.push(body);
        state.newsletterSubscription = body.sourceUrl;
        return respond(route, subscriptionResponse, { sourceId: 21 });
      }
      // Addresses are minted only: the server refuses one typed by hand.
      if (body.sourceUrl.endsWith("@mail.example"))
        return refuse(route, 422, invalidRequestMessage);
      expect(body).toEqual({
        sourceFolder: 7,
        sourceName: "Tech Preview",
        sourceUrl: "https://preview.example/feed.xml",
      });
      state.subscriptionBodies.push(body);
      state.subscribed = true;
      return respond(route, subscriptionResponse, { sourceId: 9 });
    }

    // The admin page's source list, with the two changes it can make. Only
    // the 401 matters to the specs, so the changes are acknowledged, not kept.
    if (url.pathname === "/api/admin") {
      if (!state.authenticated) return refuse(route, 401, "Unauthorized");
      // What the server answers a signed-in account that isn't an admin.
      if (options.notAdmin) return refuse(route, 403, "Unauthorized");
      if (method === "GET")
        return respond(route, adminSourcesResponse, [
          {
            createdAt: "2026-07-01T00:00:00.000Z",
            homeUrl: source.homeUrl,
            id: 3,
            lastAttempt: null,
            lastFetchTrigger: null,
            lastSuccess: null,
            recentFailureDetails: "",
            recentFailures: 0,
            subscriberCount: 1,
            url: source.xmlUrl,
            websubStatus: "none",
          },
        ]);
      if (method === "POST")
        return respond(route, successResponse, { success: true });
      if (method === "DELETE") {
        const { removeSourceId } = Value.Parse(
          removeSourceRequest,
          request.postDataJSON(),
        );
        return respond(route, removedIdResponse, removeSourceId);
      }
    }

    throw new Error(
      `Unexpected browser request: ${method} ${url.pathname}${url.search}`,
    );
  });

  return state;
}

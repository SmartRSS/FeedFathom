import { expect, type Page } from "@playwright/test";

const user = {
  email: "reader@example.com",
  id: 42,
  isAdmin: false,
  name: "Reader",
  status: "active",
};

const source = {
  favicon: null,
  homeUrl: "https://news.example/",
  name: "Tech News",
  type: "source",
  uid: "3",
  unreadCount: 2,
  xmlUrl: "https://news.example/feed.xml",
};

const subscribedSource = {
  favicon: null,
  homeUrl: "https://preview.example/",
  name: "Tech Preview",
  type: "source",
  uid: "9",
  unreadCount: 1,
  xmlUrl: "https://preview.example/feed.xml",
};

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
};

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
};

const summary = (item: typeof article) => ({
  author: item.author,
  group: "Today",
  id: item.id,
  publishedAt: item.publishedAt,
  sourceId: item.sourceId,
  title: item.title,
  url: item.url,
});

type ApiFixtureState = {
  authenticated: boolean;
  findRequests: number;
  removedArticleIds: number[];
  removedFolderIds: number[];
  removedSourceIds: number[];
  subscribed: boolean;
  subscriptionBodies: object[];
  treeRequests: number;
  updatedSource: { name: string; parentId: null | number } | undefined;
};

export async function installApiFixture(
  page: Page,
  options: {
    authenticated?: boolean;
    discoveryRace?: boolean;
    folderCreateFailure?: boolean;
    foldersFailure?: boolean;
    multipleArticles?: boolean;
    sessionFailure?: boolean;
    treeFailure?: boolean;
  } = {},
): Promise<ApiFixtureState> {
  const state: ApiFixtureState = {
    authenticated: options.authenticated ?? true,
    findRequests: 0,
    removedArticleIds: [],
    removedFolderIds: [],
    removedSourceIds: [],
    subscribed: false,
    subscriptionBodies: [],
    treeRequests: 0,
    updatedSource: undefined,
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const respond = (body: object | object[], status = 200) =>
      route.fulfill({
        body: JSON.stringify(body),
        contentType: "application/json",
        status,
      });

    if (method === "GET" && url.pathname === "/api/session") {
      if (options.sessionFailure) return respond({ user: { id: "malformed" } });
      return respond({ user: state.authenticated ? user : null });
    }

    if (method === "POST" && url.pathname === "/api/login") {
      expect(request.postDataJSON()).toEqual({
        email: "reader@example.com",
        password: "password",
      });
      state.authenticated = true;
      return respond({ sid: "browser-session" });
    }

    if (method === "POST" && url.pathname === "/api/logout") {
      state.authenticated = false;
      return respond({ success: true });
    }

    if (method === "GET" && url.pathname === "/api/tree") {
      state.treeRequests++;
      if (options.treeFailure) return respond({ tree: "malformed" });
      const currentSource = state.updatedSource
        ? { ...source, name: state.updatedSource.name }
        : source;
      return respond({
        tree: state.removedFolderIds.includes(7)
          ? []
          : [
              {
                children: [
                  ...(state.removedSourceIds.includes(3)
                    ? []
                    : [currentSource]),
                  ...(state.subscribed && !state.removedSourceIds.includes(9)
                    ? [subscribedSource]
                    : []),
                ],
                name: "Reading",
                type: "folder",
                uid: "7",
              },
            ],
      });
    }

    if (method === "POST" && url.pathname === "/api/articles") {
      if (!state.authenticated) return respond({ error: "Unauthorized" }, 401);
      const sources = request.postDataJSON().sources;
      expect(
        sources.every((sourceId: number) => [3, 9].includes(sourceId)),
      ).toBe(true);
      if (sources.length === 1 && sources[0] === 9) {
        return respond([summary(subscribedArticle)]);
      }
      const techNewsArticles = options.multipleArticles
        ? [article, secondArticle, thirdArticle]
        : [article];
      return respond(
        techNewsArticles
          .filter((item) => !state.removedArticleIds.includes(item.id))
          .map(summary),
      );
    }

    if (method === "DELETE" && url.pathname === "/api/articles") {
      const { removedArticleIdList } = request.postDataJSON();
      expect(removedArticleIdList.length > 0).toBe(true);
      state.removedArticleIds.push(...removedArticleIdList);
      return respond(removedArticleIdList);
    }

    if (method === "GET" && url.pathname === "/api/article") {
      const id = url.searchParams.get("article");
      expect(["11", "12", "13", "19"]).toContain(id);
      if (id === "19") return respond(subscribedArticle);
      if (id === "12") return respond(secondArticle);
      if (id === "13") return respond(thirdArticle);
      return respond(article);
    }

    if (method === "POST" && url.pathname === "/api/folders") {
      expect(request.postDataJSON()).toEqual({ name: "Saved" });
      if (options.folderCreateFailure) return respond({ id: "malformed" });
      return respond({
        createdAt: "2026-07-01T00:00:00.000Z",
        id: 8,
        name: "Saved",
        updatedAt: "2026-07-01T00:00:00.000Z",
        userId: 42,
      });
    }

    if (method === "DELETE" && url.pathname === "/api/source") {
      const { removeSourceId } = request.postDataJSON();
      state.removedSourceIds.push(removeSourceId);
      return respond(removeSourceId);
    }

    if (method === "PATCH" && url.pathname === "/api/source") {
      const { sourceFolder, sourceId, sourceName } = request.postDataJSON();
      expect(sourceId).toBe(3);
      state.updatedSource = { name: sourceName, parentId: sourceFolder };
      return respond({ sourceId });
    }

    if (method === "DELETE" && url.pathname === "/api/folders") {
      const { removeFolderId } = request.postDataJSON();
      state.removedFolderIds.push(removeFolderId);
      return respond(removeFolderId);
    }

    if (method === "GET" && url.pathname === "/api/folders") {
      if (!state.authenticated) return respond({ error: "Unauthorized" }, 401);
      if (options.foldersFailure) return respond({ folders: "malformed" });
      return respond([
        {
          createdAt: "2026-07-01T00:00:00.000Z",
          id: 7,
          name: "Reading",
          updatedAt: "2026-07-01T00:00:00.000Z",
          userId: 42,
        },
      ]);
    }

    if (method === "GET" && url.pathname === "/api/find") {
      state.findRequests++;
      expect(url.searchParams.get("link")).toBe("https://preview.example/");
      return respond(
        options.discoveryRace
          ? [
              {
                title: "Slow feed",
                url: "https://preview.example/slow.xml",
              },
              {
                title: "Fast feed",
                url: "https://preview.example/fast.xml",
              },
            ]
          : [
              {
                title: "Tech Preview",
                url: "https://preview.example/feed.xml",
              },
            ],
      );
    }

    if (method === "GET" && url.pathname === "/api/preview") {
      const feedUrl = url.searchParams.get("feedUrl");
      if (options.discoveryRace && feedUrl?.endsWith("/slow.xml"))
        await new Promise((resolve) => setTimeout(resolve, 200));
      else if (!options.discoveryRace)
        expect(feedUrl).toBe("https://preview.example/feed.xml");
      const title = options.discoveryRace
        ? feedUrl?.endsWith("/fast.xml")
          ? "Fast feed"
          : "Slow feed"
        : "Tech Preview";
      return respond({
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
      });
    }

    if (method === "POST" && url.pathname === "/api/subscribe") {
      const body = request.postDataJSON();
      expect(body).toEqual({
        sourceFolder: 7,
        sourceName: "Tech Preview",
        sourceUrl: "https://preview.example/feed.xml",
      });
      state.subscriptionBodies.push(body);
      state.subscribed = true;
      return respond({ sourceId: 9 });
    }

    throw new Error(
      `Unexpected browser request: ${method} ${url.pathname}${url.search}`,
    );
  });

  return state;
}

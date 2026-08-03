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
  subscribed: boolean;
  subscriptionBodies: object[];
  treeRequests: number;
};

export async function installApiFixture(
  page: Page,
  options: {
    authenticated?: boolean;
    discoveryRace?: boolean;
    folderCreateFailure?: boolean;
    foldersFailure?: boolean;
    sessionFailure?: boolean;
    treeFailure?: boolean;
  } = {},
): Promise<ApiFixtureState> {
  const state: ApiFixtureState = {
    authenticated: options.authenticated ?? true,
    findRequests: 0,
    subscribed: false,
    subscriptionBodies: [],
    treeRequests: 0,
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
      return respond({
        tree: [
          {
            children: [source, ...(state.subscribed ? [subscribedSource] : [])],
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
      return respond([
        summary(
          sources.length === 1 && sources[0] === 9
            ? subscribedArticle
            : article,
        ),
      ]);
    }

    if (method === "GET" && url.pathname === "/api/article") {
      const id = url.searchParams.get("article");
      expect(["11", "19"]).toContain(id);
      return respond(id === "19" ? subscribedArticle : article);
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

    if (method === "GET" && url.pathname === "/api/folders") {
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

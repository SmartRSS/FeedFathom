import type { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import {
  ArticleEventHub,
  type ArticleEventSubscriber,
} from "#features/reader/article-event-hub.ts";
import { articleEventsChannel } from "#features/feeds/article-events.ts";
import { expect, test } from "bun:test";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import {
  sessionUser,
  createDependencies,
  appFor,
  send,
  get,
  post,
  authenticated,
} from "../../../__tests__/server-harness.ts";

test("normalizes reader inputs and rejects malformed values before dependencies", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const articleQueries: [number[], number][] = [];
  const folders: [number, string][] = [];
  dependencies.articlesDataService.getUserArticlesForSources = async (
    sourceIds,
    userId,
  ) => {
    articleQueries.push([sourceIds, userId]);
    return [];
  };
  dependencies.foldersDataService.createFolder = async (userId, name) => {
    folders.push([userId, name]);
    const now = new Date();
    return { createdAt: now, id: 7, name, updatedAt: now, userId };
  };
  const app = await appFor(dependencies);

  const articles = await post(
    app,
    "/api/articles",
    { sources: [3, 5] },
    { auth: true },
  );
  const malformedArticles = await post(
    app,
    "/api/articles",
    { sources: [3, "nope"] },
    { auth: true },
  );
  const largeSources = Array.from({ length: 501 }, (_, index) => index + 1);
  const largeArticleRequest = await post(
    app,
    "/api/articles",
    { sources: largeSources },
    { auth: true },
  );
  const folder = await post(
    app,
    "/api/folders",
    { name: "  Reading  " },
    { auth: true },
  );
  const blankFolder = await post(
    app,
    "/api/folders",
    { name: "   " },
    { auth: true },
  );

  expect(articles.status).toBe(200);
  expect(malformedArticles.status).toBe(422);
  expect(largeArticleRequest.status).toBe(422);
  expect(folder.status).toBe(200);
  expect(blankFolder.status).toBe(422);
  expect(articleQueries).toEqual([[[3, 5], 42]]);
  expect(folders).toEqual([[42, "Reading"]]);
});

// today-window-integration covers what the Today view lists; this only pins
// that a view the contract does not name never reaches the data service.
test("rejects an unknown article view", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const app = await appFor(dependencies);

  const response = await post(
    app,
    "/api/articles",
    { sources: [3], view: "week" },
    { auth: true },
  );

  expect(response.status).toBe(422);
});

test("protects nonempty folders and deletes empty owned folders", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const deletions: Parameters<FoldersDataService["removeEmptyUserFolder"]>[] =
    [];
  dependencies.foldersDataService.removeEmptyUserFolder = async (...args) => {
    deletions.push(args);
    const [, folderId] = args;
    if (folderId === 7) return "not-empty";
    if (folderId === 9) return "not-found";
    return "removed";
  };
  const app = await appFor(dependencies);
  const removeFolder = (folderId: number) =>
    send(
      app,
      "DELETE",
      "/api/folders",
      { removeFolderId: folderId },
      { auth: true },
    );

  const nonempty = await removeFolder(7);
  expect(nonempty.status).toBe(409);
  expect(await nonempty.json()).toEqual({ error: "Folder is not empty" });
  expect(deletions).toEqual([[42, 7]]);

  const empty = await removeFolder(8);
  expect(empty.status).toBe(200);
  expect(await empty.json()).toBe(8);
  expect(deletions).toEqual([
    [42, 7],
    [42, 8],
  ]);

  const missing = await removeFolder(9);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "Folder not found" });
  expect(deletions).toEqual([
    [42, 7],
    [42, 8],
    [42, 9],
  ]);
});

test("scopes article detail to the subscriber and always returns Feed content", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const lookups: [number, number][] = [];
  const article = {
    author: "Author",
    content: "<p>Visible</p>",
    enclosures: [],
    guid: "visible-guid",
    id: 7,
    lastSeenInFeedAt: new Date(),
    publishedAt: new Date(),
    sourceId: 3,
    title: "Visible article",
    updatedAt: null,
    url: "https://example.com/article",
  };
  dependencies.articlesDataService.getUserArticle = async (
    articleId,
    userId,
  ) => {
    lookups.push([articleId, userId]);
    return articleId === article.id && userId === 42 ? article : undefined;
  };
  const app = await appFor(dependencies);
  const request = (id: number, query = "") =>
    get(app, `/api/article?article=${id}${query}`, { auth: true });

  const visible = await request(7, "&displayMode=READABILITY");
  const foreign = await request(8);
  const absent = await request(9);

  expect(visible.status).toBe(200);
  const visibleArticle: unknown = await visible.json();
  if (
    typeof visibleArticle !== "object" ||
    visibleArticle === null ||
    !("id" in visibleArticle) ||
    !("content" in visibleArticle)
  ) {
    throw new Error("Invalid article response");
  }
  expect(visibleArticle.id).toBe(7);
  expect(visibleArticle.content).toBe("<p>Visible</p>");
  expect(foreign.status).toBe(404);
  expect(await foreign.json()).toEqual({ error: "Article not found" });
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual({ error: "Article not found" });
  expect(lookups).toEqual([
    [7, 42],
    [8, 42],
    [9, 42],
  ]);
});

test("marks articles read and recomputes the badge from the store", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const marked: { articleIdList: number[]; read: boolean }[] = [];
  const recomputed: [number[], number | undefined][] = [];
  dependencies.articlesDataService.setUserArticlesRead = async (
    articleIdList,
    _userId,
    read,
  ) => {
    marked.push({ articleIdList, read });
    return { articleIds: articleIdList, sourceIds: [3] };
  };
  dependencies.userSourcesDataService.recomputeUnreadCounts = async (
    sourceIds,
    userId,
  ) => {
    recomputed.push([sourceIds, userId]);
  };
  const app = await appFor(dependencies);
  const patch = (body: unknown) =>
    send(app, "PATCH", "/api/articles", body, { auth: true });

  const read = await patch({ articleIdList: [11, 12], read: true });
  const unread = await patch({ articleIdList: [11], read: false });
  const malformed = await patch({ articleIdList: [], read: true });
  const anonymous = await send(app, "PATCH", "/api/articles", {
    articleIdList: [11],
    read: true,
  });

  expect(read.status).toBe(200);
  expect(await read.json()).toEqual([11, 12]);
  expect(unread.status).toBe(200);
  // An empty list is a client bug, not a no-op worth accepting.
  expect(malformed.status).toBe(422);
  expect(anonymous.status).toBe(401);
  expect(marked).toEqual([
    { articleIdList: [11, 12], read: true },
    { articleIdList: [11], read: false },
  ]);
  // The badge is recomputed rather than adjusted by a delta kept in the route.
  expect(recomputed).toEqual([
    [[3], sessionUser.id],
    [[3], sessionUser.id],
  ]);
});

test("passes the article list filter through to the query", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const filters: (string | undefined)[] = [];
  dependencies.articlesDataService.getUserArticlesForSources = async (
    _sources,
    _userId,
    _cursor,
    filter,
  ) => {
    filters.push(filter);
    return [];
  };
  const app = await appFor(dependencies);
  const list = (body: unknown) =>
    post(app, "/api/articles", body, { auth: true });

  await list({ sources: [3] });
  await list({ filter: "read", sources: [3] });
  await list({ filter: "all", sources: [3] });
  const rejected = await list({ filter: "everything", sources: [3] });

  // Absent means unread, which is all the list has ever shown; the default
  // lives in the data service rather than being spelled out per caller.
  expect(filters).toEqual([undefined, "read", "all"]);
  expect(rejected.status).toBe(422);
});

// A bundle from before #992 rejects the extra field, so only a request that
// asks gets it.
test("lists article revisions only when asked", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.articlesDataService.getUserArticlesForSources = async () => [
    {
      author: "A",
      group: "Today",
      id: 11,
      publishedAt: new Date("2026-10-06T10:00:00.000Z"),
      read: false,
      revision: "2026-10-06 10:00:00.000001+00",
      sourceId: 3,
      title: "T",
      url: "https://articles.example/1",
    },
  ];
  const app = await appFor(dependencies);
  const list = async (body: unknown) => {
    const response = await post(app, "/api/articles", body, { auth: true });
    const rows: { revision?: string }[] = await response.json();
    return rows.map((row) => row.revision);
  };

  expect(await list({ sources: [3] })).toEqual([undefined]);
  expect(await list({ revision: true, sources: [3] })).toEqual([
    "2026-10-06 10:00:00.000001+00",
  ]);
});

test("searches every subscription rather than the selected sources", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const calls: { options: unknown; sources: number[] }[] = [];
  dependencies.articlesDataService.getUserArticlesForSources = async (
    sources,
    _userId,
    _cursor,
    _filter,
    options,
  ) => {
    calls.push({ options, sources });
    return [];
  };
  const app = await appFor(dependencies);
  const list = (body: unknown) =>
    post(app, "/api/articles", body, { auth: true });

  const searched = await list({ query: "  service mesh ", sources: [] });
  const scoped = await list({ query: "mesh", sources: [3] });
  const blank = await list({ query: "   ", sources: [] });
  const tooLong = await list({ query: "x".repeat(201), sources: [] });
  const noQuery = await list({ sources: [] });

  expect(searched.status).toBe(200);
  expect(scoped.status).toBe(200);
  // Trimmed, and `sources` is ignored the way the Today view ignores it: the
  // point of search is the article whose feed the reader has forgotten.
  expect(calls).toEqual([
    { options: { allSubscribed: true, query: "service mesh" }, sources: [] },
    { options: { allSubscribed: true, query: "mesh" }, sources: [3] },
  ]);
  expect(blank.status).toBe(422);
  expect(tooLong.status).toBe(422);
  // No query and no sources is still the early return, not a search for
  // everything.
  expect(noQuery.status).toBe(200);
  expect(await noQuery.json()).toEqual([]);
});

test("snoozes and unsnoozes one subscription without touching article state", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const snoozed: { pausedUntil: Date | null; sourceId: number }[] = [];
  dependencies.userSourcesDataService.setSourceSnooze = async (
    _userId,
    sourceId,
    pausedUntil,
  ) => {
    snoozed.push({ pausedUntil, sourceId });
    if (sourceId === 9) return undefined;
    return { id: sourceId, pausedUntil };
  };
  const app = await appFor(dependencies);
  const snooze = (body: unknown, authed = true) =>
    send(app, "PATCH", "/api/source/snooze", body, { auth: authed });

  const snoozeWeek = await snooze({
    pausedUntil: "2026-09-16T12:00:00.000Z",
    sourceId: 3,
  });
  const unsnooze = await snooze({ pausedUntil: null, sourceId: 3 });
  const unknown = await snooze({
    pausedUntil: "2026-09-16T12:00:00.000Z",
    sourceId: 9,
  });
  const malformed = await snooze({ pausedUntil: "next week", sourceId: 3 });
  const anonymous = await snooze({ pausedUntil: null, sourceId: 3 }, false);

  expect(snoozeWeek.status).toBe(200);
  expect(await snoozeWeek.json()).toEqual({
    pausedUntil: "2026-09-16T12:00:00.000Z",
    sourceId: 3,
  });
  expect(unsnooze.status).toBe(200);
  expect(await unsnooze.json()).toEqual({ pausedUntil: null, sourceId: 3 });
  expect(unknown.status).toBe(400);
  expect(malformed.status).toBe(422);
  expect(anonymous.status).toBe(401);
  expect(snoozed).toEqual([
    { pausedUntil: new Date("2026-09-16T12:00:00.000Z"), sourceId: 3 },
    { pausedUntil: null, sourceId: 3 },
    { pausedUntil: new Date("2026-09-16T12:00:00.000Z"), sourceId: 9 },
  ]);
});

// #991: one shared subscriber fans out to every stream, and each stream
// forwards only the sources its user subscribes to.
test("the event stream forwards only the user's sources and unlistens on cancel", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  let deliver: ((channel: string, message: string) => void) | undefined;
  let connections = 0;
  const subscriber: ArticleEventSubscriber = {
    disconnect: () => {},
    on: (_event, listener) => {
      deliver = listener;
    },
    subscribe: async () => 1,
  };
  const hub = new ArticleEventHub(() => {
    connections++;
    return subscriber;
  });
  let unlistened = 0;
  dependencies.articleEventHub = strictFake<ArticleEventHub>({
    close: () => hub.close(),
    listen: (listener) => {
      const off = hub.listen(listener);
      return () => {
        unlistened++;
        off();
      };
    },
  });
  dependencies.userSourcesDataService.getUserSourceIds = async (userId) =>
    userId === sessionUser.id ? [3] : [];
  const app = await appFor(dependencies);
  const open = async () => await get(app, "/api/events", { auth: true });

  const first = await open();
  const second = await open();
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("text/event-stream");
  expect(first.headers.get("cache-control")).toBe("no-cache");
  expect(first.headers.get("x-accel-buffering")).toBe("no");
  const reader = first.body!.getReader();
  const decoder = new TextDecoder();
  const next = async () => decoder.decode((await reader.read()).value);
  expect(await next()).toContain(": connected");
  expect(connections).toBe(1);

  deliver?.("another-channel", JSON.stringify({ count: 1, sourceId: 3 }));
  deliver?.(articleEventsChannel, "not json");
  deliver?.(articleEventsChannel, JSON.stringify({ count: 2, sourceId: 4 }));
  deliver?.(articleEventsChannel, JSON.stringify({ count: 5, sourceId: 3 }));
  expect(await next()).toBe('data: {"count":5,"sourceId":3}\n\n');

  await reader.cancel();
  expect(unlistened).toBe(1);
  await second.body!.cancel();
  expect(unlistened).toBe(2);
});

test("a client gone during the source lookup leaves no listener behind", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const controller = new AbortController();
  dependencies.userSourcesDataService.getUserSourceIds = async () => {
    controller.abort();
    return [3];
  };
  let listening = 0;
  dependencies.articleEventHub = strictFake<ArticleEventHub>({
    close: () => {},
    listen: () => {
      listening++;
      return () => {
        listening--;
      };
    },
  });
  const app = await appFor(dependencies);
  await app.handle(
    new Request("http://localhost/api/events", {
      headers: { cookie: "sid=test" },
      signal: controller.signal,
    }),
  );

  expect(listening).toBe(0);
});

test("closing the hub ends open event streams", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const hub = new ArticleEventHub(() => ({
    disconnect: () => {},
    on: () => {},
    subscribe: async () => 1,
  }));
  dependencies.articleEventHub = hub;
  const app = await appFor(dependencies);
  const response = await get(app, "/api/events", { auth: true });
  const reader = response.body!.getReader();
  await reader.read();

  hub.close();
  expect((await reader.read()).done).toBe(true);

  // A stream that registers after shutdown began ends rather than resubscribe.
  const late = await get(app, "/api/events", { auth: true });
  const lateReader = late.body!.getReader();
  await lateReader.read();
  expect((await lateReader.read()).done).toBe(true);
});

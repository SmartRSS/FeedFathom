import { accountHeader } from "#shared/contracts/headers.ts";
import type { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import { expect, test } from "bun:test";
import {
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
    sanitizedVersion: 0,
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

test("lists article revisions only when asked", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.articlesDataService.getUserArticlesForSources = async () => [
    {
      author: "A",
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

const removals: [string, object][] = [
  ["/api/source", { removeSourceId: 3 }],
  ["/api/folders", { removeFolderId: 3 }],
  ["/api/articles", { removedArticleIdList: [3] }],
];

const removalApp = async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.authenticate = async (sid) =>
    sid === "account-2" ? { ...sessionUser, id: 2 } : undefined;
  const removedFor: number[] = [];
  dependencies.userSourcesDataService.removeSourceFromUser = async (userId) => {
    removedFor.push(userId);
  };
  dependencies.foldersDataService.removeEmptyUserFolder = async (userId) => {
    removedFor.push(userId);
    return "removed";
  };
  dependencies.articlesDataService.removeUserArticles = async (
    articleIds,
    userId,
  ) => {
    removedFor.push(userId);
    return { articleIds, sourceIds: [] };
  };
  dependencies.userSourcesDataService.recomputeUnreadCounts = async () =>
    undefined;
  return { app: await appFor(dependencies), removedFor };
};

test.each(removals)(
  "DELETE %s signed in as account 2 refuses a request made for account 1 and removes nothing",
  async (path, body) => {
    const { app, removedFor } = await removalApp();
    const remove = (named?: string) =>
      send(app, "DELETE", path, body, {
        headers: {
          cookie: "sid=account-2",
          ...(named === undefined ? {} : { [accountHeader]: named }),
        },
      });

    const forAccount1 = await remove("1");
    expect(forAccount1.status).toBe(412);
    expect(removedFor).toEqual([]);

    const forAccount2 = await remove("2");
    const unnamed = await remove();
    expect(forAccount2.status).toBe(200);
    expect(unnamed.status).toBe(200);
    expect(removedFor).toEqual([2, 2]);
  },
);

test.each(removals)(
  "DELETE %s without a live session answers 401, not 412, to a request that names an account",
  async (path, body) => {
    const { app, removedFor } = await removalApp();

    const signedOut = await send(app, "DELETE", path, body, {
      headers: { [accountHeader]: "1" },
    });
    const expired = await send(app, "DELETE", path, body, {
      headers: { [accountHeader]: "1", cookie: "sid=expired" },
    });

    expect(signedOut.status).toBe(401);
    expect(expired.status).toBe(401);
    expect(removedFor).toEqual([]);
  },
);

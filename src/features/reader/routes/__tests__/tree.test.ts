import { expect, mock, test } from "bun:test";

// A source's favicon URL carries the SQL-computed content fingerprint
// (getUserSources) as ?v= (#902), so the browser can cache the response
// forever: the URL only changes when sources.favicon does.
await mock.module("#features/feeds/services.ts", () => ({
  foldersDataService: { getUserFolders: async () => [] },
  userSourcesDataService: {
    getUserSources: async () => [
      {
        faviconFingerprint: "d41d8cd98f00b204e9800998ecf8427e",
        homeUrl: "https://a.example/",
        id: 1,
        kind: "feed",
        name: "With icon",
        parentId: null,
        pausedUntil: null,
        unreadArticlesCount: 0,
        url: "https://a.example/feed.xml",
      },
      {
        faviconFingerprint: null,
        homeUrl: "https://b.example/",
        id: 2,
        kind: "feed",
        name: "No icon",
        parentId: null,
        pausedUntil: null,
        unreadArticlesCount: 0,
        url: "https://b.example/feed.xml",
      },
    ],
  },
}));

const { getTreeHandler } = await import("#features/reader/routes/tree.ts");

test("a source's favicon URL carries its fingerprint, and a source with no icon gets none", async () => {
  const response = await getTreeHandler({
    user: { id: 1 },
  } as Parameters<typeof getTreeHandler>[0]);
  const body = (await response.json()) as { tree: unknown[] };
  expect(body.tree).toEqual([
    {
      favicon: "/api/favicon/1?v=d41d8cd98f00b204e9800998ecf8427e",
      homeUrl: "https://a.example/",
      kind: "feed",
      name: "With icon",
      pausedUntil: null,
      type: "source",
      uid: "1",
      unreadCount: 0,
      xmlUrl: "https://a.example/feed.xml",
    },
    {
      favicon: null,
      homeUrl: "https://b.example/",
      kind: "feed",
      name: "No icon",
      pausedUntil: null,
      type: "source",
      uid: "2",
      unreadCount: 0,
      xmlUrl: "https://b.example/feed.xml",
    },
  ]);
});

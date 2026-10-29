import { expect, test } from "bun:test";
import type { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import { getTreeHandler } from "#features/reader/routes/tree.ts";
import type { AuthedUser } from "#features/auth/session-plugin.ts";

// A source's favicon URL carries the SQL-computed content fingerprint
// (getUserSources) as ?v= (#902), so the browser can cache the response
// forever: the URL only changes when sources.favicon does.
const services = {
  foldersDataService: strictFake<FoldersDataService>({
    getUserFolders: async () => [],
  }),
  userSourcesDataService: strictFake<UserSourcesDataService>({
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
  }),
};

test("a source's favicon URL carries its fingerprint, and a source with no icon gets none", async () => {
  const response = await getTreeHandler(
    { user: strictFake<AuthedUser>({ id: 1 }) },
    services,
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
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

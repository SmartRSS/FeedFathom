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
        lastSuccess: null,
        name: "With icon",
        parentId: null,
        pausedUntil: null,
        recentFailureDetails: "",
        recentFailures: 0,
        unreadArticlesCount: 0,
        url: "https://a.example/feed.xml",
      },
      {
        faviconFingerprint: null,
        homeUrl: "https://b.example/",
        id: 2,
        kind: "feed",
        lastSuccess: null,
        name: "No icon",
        parentId: null,
        pausedUntil: null,
        recentFailureDetails: "",
        recentFailures: 0,
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
      failing: null,
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
      failing: null,
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

const failingSource = (id: number, recentFailures: number) => ({
  faviconFingerprint: null,
  homeUrl: "https://c.example/",
  id,
  kind: "feed" as const,
  lastSuccess: new Date("2026-11-01T10:00:00.000Z"),
  name: `Source ${id}`,
  parentId: null,
  pausedUntil: null,
  recentFailureDetails: "HTTP 404",
  recentFailures,
  unreadArticlesCount: 0,
  url: "https://c.example/feed.xml",
});

test("a source whose fetches keep failing carries the reason; one blip does not", async () => {
  const response = await getTreeHandler(
    { user: strictFake<AuthedUser>({ id: 1 }) },
    {
      ...services,
      userSourcesDataService: strictFake<UserSourcesDataService>({
        getUserSources: async () => [failingSource(3, 2), failingSource(4, 1)],
      }),
    },
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const body = (await response.json()) as { tree: { failing: unknown }[] };
  expect(body.tree.map(({ failing }) => failing)).toEqual([
    { lastSuccess: "2026-11-01T10:00:00.000Z", reason: "HTTP 404" },
    null,
  ]);
});

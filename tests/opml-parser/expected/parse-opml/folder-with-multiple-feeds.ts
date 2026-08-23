import type { OpmlFolder, OpmlSource } from "#shared/types/opml-types.ts";

export const expected: Array<OpmlFolder | OpmlSource> = [
  {
    children: [
      {
        homeUrl: "https://example.com/tech",
        name: "Tech News",
        type: "source",
        xmlUrl: "https://example.com/tech/feed.xml",
      },
      {
        homeUrl: "https://example.com/world",
        name: "World News",
        type: "source",
        xmlUrl: "https://example.com/world/feed.xml",
      },
    ],
    name: "News",
    type: "folder",
  },
];

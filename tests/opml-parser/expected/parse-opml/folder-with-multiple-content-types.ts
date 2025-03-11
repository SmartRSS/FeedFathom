import type {
  OpmlFolder,
  OpmlSource,
} from "../../../../src/types/opml-types.ts";

export const expected: Array<OpmlFolder | OpmlSource> = [
  {
    children: [
      {
        homeUrl: "https://example.com/atom",
        name: "Atom Feed",
        type: "source",
        xmlUrl: "https://example.com/atom.xml",
      },
      {
        children: [
          {
            homeUrl: "https://example.com/rss",
            name: "RSS Feed",
            type: "source",
            xmlUrl: "https://example.com/rss.xml",
          },
        ],
        name: "Nested Folder",
        type: "folder",
      },
    ],
    name: "Mixed Feeds",
    type: "folder",
  },
];

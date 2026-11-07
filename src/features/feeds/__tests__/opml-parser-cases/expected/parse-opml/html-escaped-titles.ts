import type { OpmlFolder, OpmlSource } from "#features/feeds/opml-types.ts";

export const expected: Array<OpmlFolder | OpmlSource> = [
  {
    children: [
      {
        homeUrl: "https://www.browserling.com",
        name: "Browserling's cross-browser testing blog",
        type: "source",
        xmlUrl: "https://www.browserling.com/blog/rss.xml",
      },
      {
        homeUrl: "https://example.com",
        name: "The <dialog> element — <b>notes</b>",
        type: "source",
        xmlUrl: "https://example.com/dialog.xml",
      },
    ],
    name: "Tom & Jerry",
    type: "folder",
  },
];

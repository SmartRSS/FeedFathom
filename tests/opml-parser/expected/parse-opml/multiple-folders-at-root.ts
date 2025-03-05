import {
  type OpmlFolder,
  type OpmlSource,
} from "../../../../src/types/opml-types";

export const expected: Array<OpmlFolder | OpmlSource> = [
  {
    children: [
      {
        homeUrl: "https://example.com/tech",
        name: "Tech News",
        type: "source",
        xmlUrl: "https://example.com/tech/feed.xml",
      },
    ],
    name: "News",
    type: "folder",
  },
  {
    children: [
      {
        homeUrl: "https://example.com/blog",
        name: "Personal Blog",
        type: "source",
        xmlUrl: "https://example.com/blog/atom.xml",
      },
    ],
    name: "Blogs",
    type: "folder",
  },
];

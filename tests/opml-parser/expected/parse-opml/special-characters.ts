import type {
  OpmlFolder,
  OpmlSource,
} from "../../../../src/types/opml-types.ts";

export const expected: Array<OpmlFolder | OpmlSource> = [
  {
    children: [
      {
        homeUrl: "https://example.com/español/tech",
        name: "Blog with Ümlaut & Español",
        type: "source",
        xmlUrl: "https://example.com/blog?lang=es&category=tech",
      },
    ],
    name: "Special & Characters",
    type: "folder",
  },
];

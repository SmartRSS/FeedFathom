import type { OpmlFolder } from "../../../../src/types/opml-types.ts";

export const expected: OpmlFolder = {
  children: [
    {
      homeUrl: "https://example.com/tech",
      name: "Example Tech Blog",
      type: "source",
      xmlUrl: "https://example.com/tech/feed.xml",
    },
  ],
  name: "Tech Blogs",
  type: "folder",
};

import { type Outline } from "../../../../src/types/opml-types";

export const input: Outline = {
  "@_": {
    text: "Tech Blogs",
    title: "Tech Blogs",
  },
  outline: [
    {
      "@_": {
        htmlUrl: "https://example.com/tech",
        title: "Example Tech Blog",
        type: "rss",
        xmlUrl: "https://example.com/tech/feed.xml",
      },
    },
  ],
};

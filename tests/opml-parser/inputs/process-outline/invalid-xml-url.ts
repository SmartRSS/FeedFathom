import type { Outline } from "../../../../src/types/opml-types.ts";

export const input: Outline = {
  "@_": {
    htmlUrl: "https://example.com",
    title: "Invalid XML URL Feed",
    type: "rss",
    xmlUrl: "not-a-valid-url",
  },
};

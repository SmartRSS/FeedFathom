import type { OpmlSource } from "#shared/types/opml-types.ts";

export const expected: OpmlSource[] = [
  {
    homeUrl: "https://example.com/rss",
    name: "Direct RSS Feed",
    type: "source",
    xmlUrl: "https://example.com/rss.xml",
  },
];

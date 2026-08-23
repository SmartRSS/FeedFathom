import type { OpmlSource } from "#shared/types/opml-types.ts";

export const expected: OpmlSource[] = [
  {
    homeUrl: "https://example.com",
    name: "Example Feed",
    type: "source",
    xmlUrl: "https://example.com/feed.xml",
  },
];

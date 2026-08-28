import type { OpmlSource } from "#shared/types/opml-types.ts";

export const expected: OpmlSource = {
  homeUrl: "https://example.com",
  name: "Invalid XML URL Feed",
  type: "source",
  xmlUrl: "not-a-valid-url",
};

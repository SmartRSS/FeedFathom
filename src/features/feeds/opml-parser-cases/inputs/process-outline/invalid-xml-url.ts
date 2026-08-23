import type { Outline } from "#shared/types/opml-types.ts";

export const input: Outline = {
  "@htmlUrl": "https://example.com",
  "@title": "Invalid XML URL Feed",
  "@type": "rss",
  "@xmlUrl": "not-a-valid-url",
};

import type { Outline } from "#shared/types/opml-types.ts";

export const input: Outline = {
  "@text": "Tech Blogs",
  "@title": "Tech Blogs",
  outline: [
    {
      "@htmlUrl": "https://example.com/tech",
      "@title": "Example Tech Blog",
      "@type": "rss",
      "@xmlUrl": "https://example.com/tech/feed.xml",
    },
  ],
};

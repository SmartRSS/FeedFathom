export const input = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Multiple Folders at Root</title>
  </head>
  <body>
    <outline text="News" title="News">
      <outline
        text="Tech News"
        title="Tech News"
        type="rss"
        xmlUrl="https://example.com/tech/feed.xml"
        htmlUrl="https://example.com/tech"
      />
    </outline>
    <outline text="Blogs" title="Blogs">
      <outline
        text="Personal Blog"
        title="Personal Blog"
        type="atom"
        xmlUrl="https://example.com/blog/atom.xml"
        htmlUrl="https://example.com/blog"
      />
    </outline>
  </body>
</opml>`;

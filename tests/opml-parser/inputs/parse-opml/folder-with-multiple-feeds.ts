export const input = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Folder with Multiple Feeds</title>
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
      <outline
        text="World News"
        title="World News"
        type="rss"
        xmlUrl="https://example.com/world/feed.xml"
        htmlUrl="https://example.com/world"
      />
    </outline>
  </body>
</opml>`;

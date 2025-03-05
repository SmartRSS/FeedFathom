export const input = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Folder with Multiple Content Types</title>
  </head>
  <body>
    <outline text="Mixed Feeds" title="Mixed Feeds">
      <outline
        text="Atom Feed"
        title="Atom Feed"
        type="atom"
        xmlUrl="https://example.com/atom.xml"
        htmlUrl="https://example.com/atom"
      />
      <outline text="Nested Folder" title="Nested Folder">
        <outline
          text="RSS Feed"
          title="RSS Feed"
          type="rss"
          xmlUrl="https://example.com/rss.xml"
          htmlUrl="https://example.com/rss"
        />
      </outline>
    </outline>
  </body>
</opml>`;

// Exported by a reader that stored its titles HTML-escaped and then escaped
// them again as XML attributes: after XML decoding the titles still carry
// HTML character references. A literal tag in a title is text, not markup.
export const input = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="Tom &amp;amp; Jerry" title="Tom &amp;amp; Jerry">
      <outline
        text="Browserling&amp;#39;s cross-browser testing blog"
        title="Browserling&amp;#39;s cross-browser testing blog"
        type="rss"
        xmlUrl="https://www.browserling.com/blog/rss.xml"
        htmlUrl="https://www.browserling.com"
      />
      <outline
        text="The &amp;lt;dialog&amp;gt; element &amp;#x2014; &lt;b&gt;notes&lt;/b&gt;"
        type="rss"
        xmlUrl="https://example.com/dialog.xml"
      />
    </outline>
  </body>
</opml>`;

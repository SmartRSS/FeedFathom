import { describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import { HeadScanner } from "../src/lib/scanners/head-scanner.ts";

describe("HeadScanner", () => {
  it("should detect JSON Feed links", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="alternate" type="application/json" title="JSON Feed" href="https://www.jsonfeed.org/feed.json" />
        </head>
        <body>
          <h1>Test Page</h1>
        </body>
      </html>
    `;

    const dom = new JSDOM(html, { url: "https://example.com" });
    const scanner = new HeadScanner();
    const feeds = scanner.scan(new URL("https://example.com"), dom.window.document);

    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toEqual({
      title: "JSON Feed",
      url: "https://www.jsonfeed.org/feed.json",
      type: "jsonfeed",
    });
  });

  it("should detect RSS Feed links", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="alternate" type="application/rss+xml" title="RSS Feed" href="https://example.com/feed.xml" />
        </head>
        <body>
          <h1>Test Page</h1>
        </body>
      </html>
    `;

    const dom = new JSDOM(html, { url: "https://example.com" });
    const scanner = new HeadScanner();
    const feeds = scanner.scan(new URL("https://example.com"), dom.window.document);

    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toEqual({
      title: "RSS Feed",
      url: "https://example.com/feed.xml",
      type: "rss",
    });
  });

  it("should detect Atom Feed links", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="alternate" type="application/atom+xml" title="Atom Feed" href="https://example.com/feed.atom" />
        </head>
        <body>
          <h1>Test Page</h1>
        </body>
      </html>
    `;

    const dom = new JSDOM(html, { url: "https://example.com" });
    const scanner = new HeadScanner();
    const feeds = scanner.scan(new URL("https://example.com"), dom.window.document);

    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toEqual({
      title: "Atom Feed",
      url: "https://example.com/feed.atom",
      type: "atom",
    });
  });

  it("should detect multiple feed types", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="alternate" type="application/rss+xml" title="RSS Feed" href="https://example.com/feed.xml" />
          <link rel="alternate" type="application/atom+xml" title="Atom Feed" href="https://example.com/feed.atom" />
          <link rel="alternate" type="application/json" title="JSON Feed" href="https://example.com/feed.json" />
        </head>
        <body>
          <h1>Test Page</h1>
        </body>
      </html>
    `;

    const dom = new JSDOM(html, { url: "https://example.com" });
    const scanner = new HeadScanner();
    const feeds = scanner.scan(new URL("https://example.com"), dom.window.document);

    expect(feeds).toHaveLength(3);
    
    const rssFeed = feeds.find(f => f.type === "rss");
    const atomFeed = feeds.find(f => f.type === "atom");
    const jsonFeed = feeds.find(f => f.type === "jsonfeed");

    expect(rssFeed).toBeDefined();
    expect(atomFeed).toBeDefined();
    expect(jsonFeed).toBeDefined();
    
    expect(rssFeed?.url).toBe("https://example.com/feed.xml");
    expect(atomFeed?.url).toBe("https://example.com/feed.atom");
    expect(jsonFeed?.url).toBe("https://example.com/feed.json");
  });
}); 
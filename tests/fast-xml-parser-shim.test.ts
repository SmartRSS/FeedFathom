import { describe, expect, test } from "bun:test";
// vendor/fast-xml-parser-shim stands in for the real package, so this
// resolves to the shim (see package.json "overrides").
import { XMLBuilder, XMLParser } from "fast-xml-parser";

// The shape expectations below were captured from fast-xml-parser 5.10.1
// configured exactly as @rowanmanning/feed-parser configures it, and verified
// to match it byte for byte. The real package is no longer installed, so they
// are recorded here rather than compared live. The one deliberate divergence
// is malformed input -- see the last parser test.
const parser = new XMLParser();
const builder = new XMLBuilder();

describe("XMLParser (preserveOrder shape)", () => {
  test("keys each element by tag name and hangs attributes off :@", () => {
    expect(parser.parse(`<a href="u">t</a>`)).toEqual([
      { ":@": { href: "u" }, a: [{ "#text": "t" }] },
    ]);
  });

  test("omits :@ entirely when an element has no attributes", () => {
    expect(parser.parse(`<a>t</a>`)).toEqual([{ a: [{ "#text": "t" }] }]);
  });

  test("keeps differently named siblings in document order", () => {
    expect(parser.parse(`<r><b/><c/><b/></r>`)).toEqual([
      { r: [{ b: [] }, { c: [] }, { b: [] }] },
    ]);
  });

  test("preserves whitespace between elements as text nodes", () => {
    expect(parser.parse(`<r>\n  <b/>\n</r>`)).toEqual([
      { r: [{ "#text": "\n  " }, { b: [] }, { "#text": "\n" }] },
    ]);
  });

  test("keeps namespace prefixes on names and attributes", () => {
    expect(parser.parse(`<dc:c xml:base="b">Z</dc:c>`)).toEqual([
      { ":@": { "xml:base": "b" }, "dc:c": [{ "#text": "Z" }] },
    ]);
  });

  test("drops comments and merges the text runs they separated", () => {
    expect(parser.parse(`<r>a<!--x-->b</r>`)).toEqual([
      { r: [{ "#text": "ab" }] },
    ]);
  });

  test("unwraps CDATA into ordinary text", () => {
    expect(parser.parse(`<r><![CDATA[<p>x</p>]]></r>`)).toEqual([
      { r: [{ "#text": "<p>x</p>" }] },
    ]);
  });

  // Deliberate divergence, not captured behaviour: the real parser recovers
  // from this and returns a tree. Bun.XML is a conforming processor, so
  // malformed input fails loudly instead of yielding silently truncated data.
  test("throws on malformed XML where the real parser recovered", () => {
    expect(() => parser.parse(`<a><b></a>`)).toThrow();
  });
});

describe("XMLBuilder", () => {
  test("round-trips an element with attributes", () => {
    expect(
      builder.build([{ ":@": { href: "u" }, a: [{ "#text": "x" }] }]),
    ).toBe(`<a href="u">x</a>`);
  });

  test("writes an empty element as an open/close pair, not self-closing", () => {
    expect(builder.build([{ p: [] }])).toBe("<p></p>");
  });

  test("escapes all five predefined entities in text and attributes", () => {
    const chars = `& < > " '`;
    expect(builder.build([{ x: [{ "#text": chars }] }])).toBe(
      `<x>&amp; &lt; &gt; &quot; &apos;</x>`,
    );
    expect(builder.build([{ ":@": { a: chars }, x: [] }])).toBe(
      `<x a="&amp; &lt; &gt; &quot; &apos;"></x>`,
    );
  });

  test("serialises nested children in order", () => {
    expect(
      builder.build([
        { div: [{ b: [{ "#text": "t" }] }, { "#text": " tail" }] },
      ]),
    ).toBe("<div><b>t</b> tail</div>");
  });

  test("ignores a node with no tag name", () => {
    expect(builder.build([{}])).toBe("");
  });
});

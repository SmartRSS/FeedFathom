import { describe, expect, test } from "bun:test";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

const parser = new XMLParser();
const builder = new XMLBuilder();

describe("XMLParser (preserveOrder shape)", () => {
  test.each([
    [
      "keys each element by tag name and hangs attributes off :@",
      `<a href="u">t</a>`,
      [{ ":@": { href: "u" }, a: [{ "#text": "t" }] }],
    ],
    [
      "omits :@ entirely when an element has no attributes",
      `<a>t</a>`,
      [{ a: [{ "#text": "t" }] }],
    ],
    [
      "keeps differently named siblings in document order",
      `<r><b/><c/><b/></r>`,
      [{ r: [{ b: [] }, { c: [] }, { b: [] }] }],
    ],
    [
      "preserves whitespace between elements as text nodes",
      `<r>\n  <b/>\n</r>`,
      [{ r: [{ "#text": "\n  " }, { b: [] }, { "#text": "\n" }] }],
    ],
    [
      "keeps namespace prefixes on names and attributes",
      `<dc:c xml:base="b">Z</dc:c>`,
      [{ ":@": { "xml:base": "b" }, "dc:c": [{ "#text": "Z" }] }],
    ],
    [
      "drops comments and merges the text runs they separated",
      `<r>a<!--x-->b</r>`,
      [{ r: [{ "#text": "ab" }] }],
    ],
    [
      "unwraps CDATA into ordinary text",
      `<r><![CDATA[<p>x</p>]]></r>`,
      [{ r: [{ "#text": "<p>x</p>" }] }],
    ],
  ])("%s", (_behaviour, xml, expected) => {
    expect(parser.parse(xml)).toEqual(expected);
  });

  test("throws on malformed XML where the real parser recovered", () => {
    expect(() => parser.parse(`<a><b></a>`)).toThrow();
  });
});

describe("XMLBuilder", () => {
  test.each([
    [
      "round-trips an element with attributes",
      [{ ":@": { href: "u" }, a: [{ "#text": "x" }] }],
      `<a href="u">x</a>`,
    ],
    [
      "writes an empty element as an open/close pair, not self-closing",
      [{ p: [] }],
      "<p></p>",
    ],
    [
      "serialises nested children in order",
      [{ div: [{ b: [{ "#text": "t" }] }, { "#text": " tail" }] }],
      "<div><b>t</b> tail</div>",
    ],
    ["ignores a node with no tag name", [{}], ""],
  ])("%s", (_behaviour, nodes, xml) => {
    expect(builder.build(nodes)).toBe(xml);
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
});

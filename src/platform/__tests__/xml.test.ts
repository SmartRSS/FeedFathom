import { describe, expect, test } from "bun:test";
import { parseXml, xmlSafeText } from "#platform/xml.ts";

describe("xmlSafeText", () => {
  test("strips the C0 controls XML cannot represent", () => {
    const stripped = [
      "\u0000",
      "\u0001",
      "\u0008",
      "\u000b",
      "\u000c",
      "\u000e",
      "\u001f",
    ];
    for (const control of stripped) {
      expect(xmlSafeText(`a${control}b`)).toBe("ab");
    }
  });

  test("keeps tab, newline, carriage return, DEL, and C1 controls", () => {
    expect(xmlSafeText("a\tb\nc\rd\u007fe\u0080f\u009f")).toBe(
      "a\tb\nc\rd\u007fe\u0080f\u009f",
    );
  });

  test("strips the two noncharacters", () => {
    expect(xmlSafeText("a\ufffeb\uffff")).toBe("ab");
  });

  test("strips lone surrogates but keeps well-formed astral pairs", () => {
    const high = String.fromCodePoint(0xd83d);
    const low = String.fromCodePoint(0xde00);
    expect(xmlSafeText(`a${high}b${low}c`)).toBe("abc");
    expect(xmlSafeText("a\u{1f600}b")).toBe("a\u{1f600}b");
  });

  test("leaves ordinary text untouched", () => {
    expect(xmlSafeText('<title> Tom & Jerry -- "quoted" </title>')).toBe(
      '<title> Tom & Jerry -- "quoted" </title>',
    );
  });

  test("the strip is what lets Bun.XML.stringify serialize an export", () => {
    const hostile = "a\u0000b\tc\nd\u000ee\uffff\ufffd\u{1f600}";
    expect(() => Bun.XML.stringify({ root: hostile })).toThrow();

    const safe = xmlSafeText(hostile);
    expect(() => Bun.XML.stringify({ root: safe })).not.toThrow();
    expect(safe).toBe("ab\tc\nde\ufffd\u{1f600}");
  });
});

test("rejects declared entities but not an external DTD or CDATA", () => {
  expect(() =>
    parseXml(`\uFEFF<?xml version="1.0"?>
      <!-- generator --><!DOCTYPE root [<!ENTITY payload "expanded">]><root />`),
  ).toThrow("XML entity declarations are not allowed");
  expect(
    parseXml(
      `<?xml version="1.0"?><!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd"><rss version="0.91" />`,
    ),
  ).toEqual({ rss: { "@version": "0.91" } });
  expect(parseXml("<root><![CDATA[<!DOCTYPE html [ ]>]]></root>")).toEqual({
    root: "<!DOCTYPE html [ ]>",
  });
});

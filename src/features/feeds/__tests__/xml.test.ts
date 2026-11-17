import { describe, expect, test } from "bun:test";
import {
  parseRepairingXml,
  parseXml,
  repairXml,
  xmlSafeText,
} from "#features/feeds/xml.ts";

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

  test("strips the two noncharacters but keeps the replacement character", () => {
    expect(xmlSafeText("a\ufffeb\uffffc\ufffd")).toBe("abc\ufffd");
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

describe("repairXml", () => {
  test("drops whitespace before the XML declaration", () => {
    expect(repairXml('\n  <?xml version="1.0"?><rss />')).toBe(
      '<?xml version="1.0"?><rss />',
    );
  });

  test("drops what follows the root element's end tag", () => {
    expect(repairXml("<rss><item /></rss><script>var a = 1;</script>\n")).toBe(
      "<rss><item /></rss>",
    );
    expect(repairXml("<atom:feed></atom:feed><!-- cache -->")).toBe(
      "<atom:feed></atom:feed>",
    );
  });

  test("strips control characters XML cannot hold", () => {
    expect(repairXml("<t>a\u000cb\u000bc</t>")).toBe("<t>abc</t>");
  });

  test("escapes a bare ampersand outside CDATA and comments", () => {
    expect(
      repairXml("<t a='x&y'>Tom & Jerry<![CDATA[R&D]]><!-- Q&A --></t>"),
    ).toBe("<t a='x&amp;y'>Tom &amp; Jerry<![CDATA[R&D]]><!-- Q&A --></t>");
  });

  test("decodes HTML named entities and keeps XML and numeric ones", () => {
    expect(repairXml("<t>Caf&eacute;&nbsp;&amp;&lt;&#43;&#x2B;</t>")).toBe(
      "<t>Caf\u00e9\u00a0&amp;&lt;&#43;&#x2B;</t>",
    );
  });

  test("keeps an unknown or markup-producing entity as text", () => {
    expect(repairXml("<t>&bogus; &LT;</t>")).toBe(
      "<t>&amp;bogus; &amp;LT;</t>",
    );
  });

  test("leaves a well-formed document parsing the same", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd">
<rss><channel><title>A &amp; B &#43; C</title><description><![CDATA[<p>x & y</p>]]></description><!-- a </rss> b --></channel></rss>
<!-- served by cache -->
`;
    expect(Bun.XML.parse(repairXml(xml), { compact: false })).toEqual(
      Bun.XML.parse(xml, { compact: false }),
    );
  });
});

describe("parseRepairingXml", () => {
  test("parses a document Bun.XML rejects once it is repaired", () => {
    expect(parseXml("  <?xml version='1.0'?><r>Tom & Jerry</r><x/>")).toEqual({
      r: "Tom & Jerry",
    });
  });

  test("throws the original error when the repair is not enough", () => {
    expect(() => parseXml("<r><a></r>")).toThrow(
      "Expected closing tag </a> but found </r>",
    );
  });

  test("does not retry an error that is not a parse error", () => {
    let calls = 0;
    expect(() =>
      parseRepairingXml("<r/>", () => {
        calls++;
        throw new Error("not a feed");
      }),
    ).toThrow("not a feed");
    expect(calls).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import { decodeHtml } from "../decode-body.ts";

// Page bodies as they arrive on the wire. Markup is ASCII, so a string part is
// one byte per char; non-ASCII text is always a literal byte array, never a JS
// string, which would already be decoded.
const asciiCodes = (text: string) =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
const page = (title: number[], head = "") =>
  Uint8Array.from([
    ...asciiCodes(`<html><head>${head}</head><body><h1>`),
    ...title,
    ...asciiCodes("</h1></body></html>"),
  ]);
const privet = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]; // "Привет" in windows-1251
const nihongo = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]; // "日本語" in Shift_JIS
const zazolcUtf8 = [0x5a, 0x61, 0xc5, 0xbc, 0xc3, 0xb3, 0xc5, 0x82, 0xc4, 0x87]; // "Zażółć" in UTF-8

describe("decodeHtml", () => {
  test("decodes the Content-Type charset", () => {
    expect(
      decodeHtml(page(privet), "text/html; charset=windows-1251"),
    ).toContain("<h1>Привет</h1>");
  });

  test("sniffs <meta charset> when the header has none", () => {
    expect(
      decodeHtml(page(nihongo, '<meta charset="Shift_JIS">'), "text/html"),
    ).toContain("<h1>日本語</h1>");
  });

  test("sniffs an http-equiv Content-Type meta", () => {
    const head =
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">';
    expect(decodeHtml(page(privet, head), null)).toContain("<h1>Привет</h1>");
  });

  test("lets a BOM win over a wrong header", () => {
    const utf16le = asciiCodes("<h1>OK</h1>").flatMap((code) => [code, 0]);
    const body = Uint8Array.from([0xff, 0xfe, ...utf16le]);
    expect(decodeHtml(body, "text/html; charset=windows-1251")).toBe(
      "<h1>OK</h1>",
    );
  });

  test("falls back to UTF-8 on an unknown label", () => {
    expect(
      decodeHtml(page(zazolcUtf8), "text/html; charset=not-a-charset"),
    ).toContain("<h1>Zażółć</h1>");
  });

  // HTML's prescan, not the feed rules: an unknown header label is ignored,
  // and comments and unknown meta labels don't stop the search.
  test.each([
    ["an unknown header label", "<meta charset=windows-1251>", "charset=None"],
    [
      "a commented-out meta",
      "<!-- <meta charset=utf-8> --><meta charset=windows-1251>",
      "",
    ],
    [
      "an unknown first meta",
      "<meta charset=bogus><meta charset=windows-1251>",
      "",
    ],
  ])("sniffs the meta past %s", (_name, head, parameter) => {
    const contentType = parameter ? `text/html; ${parameter}` : "text/html";
    expect(decodeHtml(page(privet, head), contentType)).toContain(
      "<h1>Привет</h1>",
    );
  });

  // A meta read as ASCII can't truly be UTF-16, and x-user-defined means
  // windows-1252 there (the HTML spec's prescan rules).
  test.each([
    ["utf-16", zazolcUtf8, "<h1>Zażółć</h1>"],
    ["x-user-defined", [0x63, 0x61, 0x66, 0xe9], "<h1>café</h1>"],
  ])(
    "reads a meta that declares %s as the spec says",
    (label, title, expected) => {
      expect(
        decodeHtml(page(title, `<meta charset="${label}">`), "text/html"),
      ).toContain(expected);
    },
  );
});

import { expect, test } from "bun:test";
import { decodeHtmlReferences } from "#features/feeds/plain-text.ts";

test("decodes named and legacy references like html-entities", () => {
  expect(decodeHtmlReferences("Tom &amp Jerry &notit; &hellip;")).toBe(
    "Tom & Jerry ¬it; …",
  );
});

test("keeps surrogate and 0x10FFFF numeric references matching html-entities", () => {
  expect(decodeHtmlReferences("a&#xD800;b&#57343;c&#1114111;d&#39;")).toBe(
    "a\ud800b\udfffc\ufffdd'",
  );
});

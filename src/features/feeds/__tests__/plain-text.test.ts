import { expect, test } from "bun:test";
import { decodeHtmlReferences } from "#features/feeds/plain-text.ts";

test("decodes named and legacy references like html-entities", () => {
  expect(decodeHtmlReferences("Tom &amp Jerry &notit; &hellip;")).toBe(
    "Tom & Jerry ¬it; …",
  );
});

test("keeps a numeric surrogate reference as the lone surrogate html-entities produced", () => {
  expect(decodeHtmlReferences("a&#xD800;b&#39;")).toBe("a\ud800b'");
});

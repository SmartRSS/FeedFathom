import { expect, test } from "bun:test";
import { ReaderExtensionError } from "../extension-reader.ts";
import { extractReaderContent } from "../reader-extraction.ts";

// Bun has no DOMParser, so reaching the parser would reject with a
// ReferenceError: a TOO_LARGE rejection here proves the byte budget stopped
// the page first. The element limit, and that an ordinary article still
// extracts sanitized, need a real DOM and are covered in
// tests/browser/spa.spec.ts.
const oversized = `<html><body><article>${"<p>Paragraph with a <a href='/x'>link</a>.</p>".repeat(90_000)}</article></body></html>`;

for (const mode of [
  "READABILITY",
  "READABILITY_PLAIN",
  "ARTICLE_EXTRACTOR",
] as const)
  test(`${mode} rejects a page over the byte budget before parsing it`, async () => {
    const started = performance.now();
    const rejection = await extractReaderContent(
      oversized,
      "https://articles.example/large",
      mode,
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ReaderExtensionError);
    expect(rejection).toMatchObject({ code: "TOO_LARGE" });
    expect(performance.now() - started).toBeLessThan(100);
  });

test("counts the byte budget in UTF-8 bytes, not string length", async () => {
  // 1.2M characters, 2.4 MB once encoded.
  const rejection = await extractReaderContent(
    `<p>${"é".repeat(1_200_000)}</p>`,
    "https://articles.example/large",
    "READABILITY",
  ).catch((error: unknown) => error);
  expect(rejection).toMatchObject({ code: "TOO_LARGE" });
});

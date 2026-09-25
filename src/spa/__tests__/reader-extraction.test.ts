import { describe, expect, test } from "bun:test";
import { ReaderExtensionError, type ReaderMode } from "../extension-reader.ts";
import { extractReaderContent } from "../reader-extraction.ts";

// Bun has no DOMParser, so reaching the parser would fail with a
// ReferenceError. A TOO_LARGE rejection therefore also proves the budget
// turned the page away before any DOM work began.
const oversized = `<html><body><article><p>${"Long article text. ".repeat(200_000)}</p></article></body></html>`;
// The page from #929: 24,000 paragraphs with one link each, under the
// extension's 5 MiB limit.
const elementHeavy = `<html><body><article>${'<p>Paragraph text with <a href="/next">a link</a>.</p>'.repeat(24_000)}</article></body></html>`;

const modes: ReaderMode[] = [
  "READABILITY",
  "READABILITY_PLAIN",
  "ARTICLE_EXTRACTOR",
];

describe.each(modes)("%s", (mode) => {
  test.each([
    ["an oversized document", oversized],
    ["an element-heavy document", elementHeavy],
  ])("falls back on %s without parsing it", async (_, html) => {
    const extraction = extractReaderContent(
      html,
      "https://articles.example/first",
      mode,
    );
    await expect(extraction).rejects.toBeInstanceOf(ReaderExtensionError);
    await expect(extraction).rejects.toHaveProperty("code", "TOO_LARGE");
  });
});

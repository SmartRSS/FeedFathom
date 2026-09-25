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
// #947: "Ж" is one UTF-16 code unit but two UTF-8 bytes, so 1.6M of them sit
// under the 3 Mi character mark yet over the 3 MiB byte budget -- exactly
// the gap a html.length check missed for non-Latin-script pages.
const multiByteOverBudget = `<html><body><article><p>${"Ж".repeat(1_600_000)}</p></article></body></html>`;
// ASCII, comfortably under both the byte budget and the element budget, so
// the size check alone must let it through.
const asciiUnderBudget = `<html><body><article><p>${"a".repeat(3_145_000)}</p></article></body></html>`;

const modes: ReaderMode[] = [
  "READABILITY",
  "READABILITY_PLAIN",
  "ARTICLE_EXTRACTOR",
];

describe.each(modes)("%s", (mode) => {
  test.each([
    ["an oversized document", oversized],
    ["an element-heavy document", elementHeavy],
    ["a multi-byte document over the byte budget", multiByteOverBudget],
  ])("falls back on %s without parsing it", async (_, html) => {
    const extraction = extractReaderContent(
      html,
      "https://articles.example/first",
      mode,
    );
    await expect(extraction).rejects.toBeInstanceOf(ReaderExtensionError);
    await expect(extraction).rejects.toHaveProperty("code", "TOO_LARGE");
  });

  test("does not reject an ASCII document just under the byte budget as too large", async () => {
    try {
      await extractReaderContent(
        asciiUnderBudget,
        "https://articles.example/first",
        mode,
      );
    } catch (error) {
      // Bun has no DOMParser, so Readability modes are expected to fail
      // past the budget check; what matters is that it wasn't rejected for
      // being oversized.
      if (error instanceof ReaderExtensionError)
        expect(error.code).not.toBe("TOO_LARGE");
    }
  });
});

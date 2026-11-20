import { describe, expect, test } from "bun:test";
import { ReaderExtensionError } from "../extension-reader.ts";
import { extractReaderContent, type ReaderMode } from "../reader-extraction.ts";

const oversized = `<html><body><article><p>${"Long article text. ".repeat(200_000)}</p></article></body></html>`;
const elementHeavy = `<html><body><article>${'<p>Paragraph text with <a href="/next">a link</a>.</p>'.repeat(24_000)}</article></body></html>`;
const multiByteOverBudget = `<html><body><article><p>${"Ж".repeat(1_600_000)}</p></article></body></html>`;
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
      if (error instanceof ReaderExtensionError)
        expect(error.code).not.toBe("TOO_LARGE");
    }
  });
});

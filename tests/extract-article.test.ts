import { describe, expect, test } from "bun:test";
import { extractArticle } from "../src/lib/extract-article.ts";

describe("extractArticle", () => {
  test("forces rel=noopener noreferrer on links, overriding an attacker-supplied value", () => {
    const result = extractArticle(
      '<a href="https://evil.example" target="_blank" rel="opener">x</a>',
    );
    expect(result).toBe(
      '<a href="https://evil.example" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  test("forces rel regardless of target casing or whitespace", () => {
    const cases = [
      '<a href="https://evil.example" target="_BLANK" rel="opener">x</a>',
      '<a href="https://evil.example" target=" _blank" rel="opener">x</a>',
      '<a href="https://evil.example" target="_blank ">x</a>',
    ];
    for (const input of cases) {
      expect(extractArticle(input)).toContain('rel="noopener noreferrer"');
    }
  });

  test("forces rel even on links without a target attribute", () => {
    const result = extractArticle('<a href="https://example.com">x</a>');
    expect(result).toBe(
      '<a href="https://example.com" rel="noopener noreferrer">x</a>',
    );
  });

  test("returns an empty string for null/undefined content", () => {
    expect(extractArticle(null)).toBe("");
    expect(extractArticle(undefined)).toBe("");
  });
});

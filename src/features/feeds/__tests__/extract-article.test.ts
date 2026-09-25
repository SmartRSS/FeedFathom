import { describe, expect, test } from "bun:test";
import { extractArticle } from "#features/feeds/extract-article.ts";

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

  test("marks images lazy and async-decoding", () => {
    expect(
      extractArticle('<img src="https://example.com/a.png" alt="a">'),
    ).toBe(
      '<img decoding="async" loading="lazy" src="https://example.com/a.png" alt="a" />',
    );
  });

  test("leaves an author's own loading and decoding choices alone", () => {
    const result = extractArticle(
      '<img src="https://example.com/a.png" loading="eager" decoding="sync">',
    );
    expect(result).toContain('loading="eager"');
    expect(result).toContain('decoding="sync"');
  });

  test("keeps the width and height that let the browser reserve space", () => {
    const result = extractArticle(
      '<img src="https://example.com/a.png" width="640" height="360">',
    );
    expect(result).toContain('width="640"');
    expect(result).toContain('height="360"');
  });

  test("keeps sizes alongside srcset so the browser doesn't fall back to 100vw", () => {
    const result = extractArticle(
      '<img src="https://example.com/a.jpg" srcset="https://example.com/a-600.jpg 600w, https://example.com/a-2048.jpg 2048w" sizes="(min-width: 600px) 600px, 100vw">',
    );
    expect(result).toContain(
      'srcset="https://example.com/a-600.jpg 600w, https://example.com/a-2048.jpg 2048w"',
    );
    expect(result).toContain('sizes="(min-width: 600px) 600px, 100vw"');
  });

  test("keeps sizes on a picture's source alongside srcset", () => {
    const result = extractArticle(
      '<picture><source srcset="https://example.com/a-600.jpg 600w" sizes="600px" type="image/jpeg"><img src="https://example.com/a.jpg"></picture>',
    );
    expect(result).toContain('srcset="https://example.com/a-600.jpg 600w"');
    expect(result).toContain('sizes="600px"');
  });

  test("returns an empty string for null/undefined content", () => {
    expect(extractArticle(null)).toBe("");
    expect(extractArticle(undefined)).toBe("");
  });
});

import { isPlainText } from "../src/util/is-plain-text";
import { describe, expect, test } from "bun:test";

describe("isPlainText", () => {
  test("should return true for empty string", () => {
    expect(isPlainText("")).toBe(true);
  });

  test("should return true for plain text content", () => {
    expect(isPlainText("This is a plain text.")).toBe(true);
  });

  test("should return true for HTML content", () => {
    expect(isPlainText("<p>This is HTML content.</p>")).toBe(true);
  });

  test("should return true for JSON content", () => {
    expect(isPlainText('{"key": "value"}')).toBe(true);
  });

  test("should return true for XML content", () => {
    expect(isPlainText("<note><to>Tove</to></note>")).toBe(true);
  });

  test("should return true for Markdown content", () => {
    expect(isPlainText("# This is a header")).toBe(true);
  });

  test("should return false for binary data", () => {
    // Simulating binary data as a string
    const binaryString = String.fromCodePoint(0, 1, 2, 3, 4, 5);
    expect(isPlainText(binaryString)).toBe(false);
  });

  test("should return false for other binary-like strings", () => {
    expect(isPlainText("This is a string with null byte \0")).toBe(false);
  });
});

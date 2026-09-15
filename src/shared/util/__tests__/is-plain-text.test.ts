import { expect, test } from "bun:test";
import { isPlainText } from "#shared/util/is-plain-text.ts";

test("accepts empty text", () => {
  expect(isPlainText("")).toBe(true);
});

test("accepts markup, Unicode, and text whitespace", () => {
  expect(isPlainText('<p>Café 世界 😀</p>\t\r\n{"key": "value"}')).toBe(true);
});

test("rejects control characters embedded in text", () => {
  for (const code of [0, 8, 11, 12, 14, 31, 127, 159]) {
    expect(isPlainText(`before${String.fromCodePoint(code)}after`)).toBe(false);
  }
});

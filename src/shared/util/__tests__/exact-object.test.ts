import { describe, expect, test } from "bun:test";
import { hasExactKeys, isOneOf } from "#shared/util/exact-object.ts";

describe("hasExactKeys", () => {
  test("accepts an object with exactly the listed keys", () => {
    expect(hasExactKeys({ title: "t", url: "u" }, ["title", "url"])).toBe(true);
    expect(hasExactKeys({}, [])).toBe(true);
  });

  test("rejects a missing key, an extra key and non-objects", () => {
    expect(hasExactKeys({ title: "t" }, ["title", "url"])).toBe(false);
    expect(hasExactKeys({ title: "t", url: "u", x: 1 }, ["title", "url"])).toBe(
      false,
    );
    expect(hasExactKeys(null, [])).toBe(false);
    expect(hasExactKeys([], [])).toBe(false);
    expect(hasExactKeys("title", [])).toBe(false);
  });

  test("counts a hidden own property as extra", () => {
    const value = { title: "t" };
    Object.defineProperty(value, "url", { enumerable: false, value: "u" });
    expect(hasExactKeys(value, ["title"])).toBe(false);
  });
});

test("isOneOf accepts only a listed string", () => {
  expect(isOneOf("fetch", ["capabilities", "fetch"])).toBe(true);
  expect(isOneOf("FETCH", ["capabilities", "fetch"])).toBe(false);
  expect(isOneOf(undefined, ["capabilities", "fetch"])).toBe(false);
});

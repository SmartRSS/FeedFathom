import { describe, expect, test } from "bun:test";
import { faviconPath } from "../tree.ts";

describe("faviconPath", () => {
  test("a source with a stored favicon gets its URL", () => {
    expect(faviconPath({ hasFavicon: true, id: 12 })).toBe("/api/favicon/12");
  });

  test("a source with no stored favicon maps to null, not a 404-bound URL", () => {
    expect(faviconPath({ hasFavicon: false, id: 12 })).toBeNull();
  });
});

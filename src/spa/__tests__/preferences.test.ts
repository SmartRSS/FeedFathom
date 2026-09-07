import { describe, expect, test } from "bun:test";
import { isMarkReadPolicy, parseMarkReadPolicy } from "../preferences.ts";

describe("parseMarkReadPolicy", () => {
  test("defaults to manual when nothing is stored", () => {
    expect(parseMarkReadPolicy(null, null)).toBe("manual");
  });

  test("reads each valid stored value through unchanged", () => {
    expect(parseMarkReadPolicy("manual", null)).toBe("manual");
    expect(parseMarkReadPolicy("on-open", null)).toBe("on-open");
    expect(parseMarkReadPolicy("on-scroll-past", null)).toBe("on-scroll-past");
  });

  test("migrates the legacy markReadOnOpen boolean", () => {
    expect(parseMarkReadPolicy(null, "true")).toBe("on-open");
    // An explicit new value wins over whatever the legacy key holds.
    expect(parseMarkReadPolicy("manual", "true")).toBe("manual");
    expect(parseMarkReadPolicy("on-scroll-past", "true")).toBe(
      "on-scroll-past",
    );
  });

  test("anything malformed falls back to manual", () => {
    expect(parseMarkReadPolicy("always", null)).toBe("manual");
    expect(parseMarkReadPolicy(null, "false")).toBe("manual");
    expect(parseMarkReadPolicy("", "nonsense")).toBe("manual");
  });

  test("isMarkReadPolicy accepts exactly the three values", () => {
    expect(isMarkReadPolicy("manual")).toBe(true);
    expect(isMarkReadPolicy("on-open")).toBe(true);
    expect(isMarkReadPolicy("on-scroll-past")).toBe(true);
    expect(isMarkReadPolicy("true")).toBe(false);
    expect(isMarkReadPolicy("")).toBe(false);
  });
});

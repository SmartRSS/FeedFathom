import { describe, expect, test } from "bun:test";
import { isMimeText } from "../src/util/is-mime-text";

describe("isMimeText", () => {
  test("should return true for empty string", () => {
    expect(isMimeText("")).toBe(true);
  });

  test("should return true for 'text/plain'", () => {
    expect(isMimeText("text/plain")).toBe(true);
  });

  test("should return true for 'application/xml'", () => {
    expect(isMimeText("application/xml")).toBe(true);
  });

  test("should return true for any type containing 'text'", () => {
    expect(isMimeText("text/html")).toBe(true);
    expect(isMimeText("text/css")).toBe(true);
    expect(isMimeText("text/javascript")).toBe(true);
    expect(isMimeText("text/anything")).toBe(true);
  });

  test("should return false for other MIME types", () => {
    expect(isMimeText("application/json")).toBe(false);
    expect(isMimeText("image/png")).toBe(false);
    expect(isMimeText("video/mp4")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { isTextEntry, mapArticleShortcut } from "../keyboard-shortcuts.ts";

const key = (event: Partial<KeyboardEvent>) => ({
  altKey: false,
  ctrlKey: false,
  key: "",
  metaKey: false,
  ...event,
});

describe("mapArticleShortcut", () => {
  test("maps the plain #709 vocabulary", () => {
    expect(mapArticleShortcut(key({ key: "j" }))).toBe("next");
    expect(mapArticleShortcut(key({ key: "k" }))).toBe("previous");
    expect(mapArticleShortcut(key({ key: "o" }))).toBe("open");
    expect(mapArticleShortcut(key({ key: "v" }))).toBe("openOriginal");
    expect(mapArticleShortcut(key({ key: "r" }))).toBe("refresh");
    expect(mapArticleShortcut(key({ key: "?" }))).toBe("help");
  });

  test("never fires with a modifier held", () => {
    expect(mapArticleShortcut(key({ ctrlKey: true, key: "r" }))).toBeNull();
    expect(mapArticleShortcut(key({ key: "j", metaKey: true }))).toBeNull();
    expect(mapArticleShortcut(key({ altKey: true, key: "k" }))).toBeNull();
  });

  test("leaves every other key alone", () => {
    expect(mapArticleShortcut(key({ key: "ArrowDown" }))).toBeNull();
    expect(mapArticleShortcut(key({ key: "m" }))).toBeNull();
    expect(mapArticleShortcut(key({ key: "J" }))).toBeNull();
    expect(mapArticleShortcut(key({ key: "Enter" }))).toBeNull();
    expect(mapArticleShortcut(key({ key: "" }))).toBeNull();
  });
});

describe("isTextEntry", () => {
  test("recognises the text-entry elements", () => {
    expect(isTextEntry({ nodeName: "INPUT" })).toBe(true);
    expect(isTextEntry({ nodeName: "textarea" })).toBe(true);
    expect(isTextEntry({ nodeName: "SELECT" })).toBe(true);
    expect(isTextEntry({ isContentEditable: true, nodeName: "INPUT" })).toBe(
      true,
    );
  });

  test("anything editable counts even without a text tag", () => {
    expect(isTextEntry({ isContentEditable: true, nodeName: "DIV" })).toBe(
      true,
    );
  });

  test("list rows and other elements do not count", () => {
    expect(isTextEntry({ nodeName: "A" })).toBe(false);
    expect(isTextEntry({ nodeName: "DIV" })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(undefined)).toBe(false);
  });
});

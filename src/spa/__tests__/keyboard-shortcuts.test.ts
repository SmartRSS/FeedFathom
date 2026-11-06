import { describe, expect, test } from "bun:test";
import { isTextEntry, mapArticleKey } from "../keyboard-shortcuts.ts";

const key = (event: Partial<KeyboardEvent>) => ({
  altKey: false,
  ctrlKey: false,
  key: "",
  metaKey: false,
  shiftKey: false,
  ...event,
});

describe("mapArticleKey", () => {
  test("maps the plain #709 vocabulary", () => {
    expect(mapArticleKey(key({ key: "j" }))).toBe("next");
    expect(mapArticleKey(key({ key: "k" }))).toBe("previous");
    expect(mapArticleKey(key({ key: "o" }))).toBe("open");
    expect(mapArticleKey(key({ key: "v" }))).toBe("openOriginal");
    expect(mapArticleKey(key({ key: "r" }))).toBe("refresh");
    expect(mapArticleKey(key({ key: "?" }))).toBe("help");
    expect(mapArticleKey(key({ key: "Enter" }))).toBe("read");
  });

  test("the letters never fire with a modifier held", () => {
    expect(mapArticleKey(key({ ctrlKey: true, key: "Enter" }))).toBeNull();
    expect(mapArticleKey(key({ ctrlKey: true, key: "r" }))).toBeNull();
    expect(mapArticleKey(key({ key: "j", metaKey: true }))).toBeNull();
    expect(mapArticleKey(key({ altKey: true, key: "k" }))).toBeNull();
  });

  test("the navigation keys answer with a modifier too", () => {
    expect(mapArticleKey(key({ ctrlKey: true, key: "ArrowDown" }))).toBe(
      "next",
    );
    expect(mapArticleKey(key({ key: "Home", metaKey: true }))).toBe("first");
    expect(mapArticleKey(key({ key: " ", shiftKey: true }))).toBe(
      "toggleSelection",
    );
  });

  test("m toggles read state in either case, unless Ctrl or Cmd is held", () => {
    expect(mapArticleKey(key({ key: "m" }))).toBe("toggleRead");
    expect(mapArticleKey(key({ key: "M" }))).toBe("toggleRead");
    expect(mapArticleKey(key({ ctrlKey: true, key: "m" }))).toBeNull();
  });

  test("Ctrl or Cmd with A selects everything", () => {
    expect(mapArticleKey(key({ ctrlKey: true, key: "a" }))).toBe("selectAll");
    expect(mapArticleKey(key({ key: "A", metaKey: true }))).toBe("selectAll");
    expect(mapArticleKey(key({ key: "a" }))).toBeNull();
  });

  test("leaves every other key alone", () => {
    expect(mapArticleKey(key({ key: "J" }))).toBeNull();
    expect(mapArticleKey(key({ key: "" }))).toBeNull();
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

import { expect, test } from "bun:test";
import { safeArticleUrl, safeHttpUrl } from "#shared/util/safe-url.ts";

const BASE = "https://example.com/feed/page";

test("accepts absolute http and https URLs", () => {
  expect(safeHttpUrl("http://example.com/a", BASE)).toBe(
    "http://example.com/a",
  );
  expect(safeHttpUrl("https://other.org/b?x=1#frag", BASE)).toBe(
    "https://other.org/b?x=1#frag",
  );
});

test("resolves relative URLs against the base", () => {
  expect(safeHttpUrl("post/1", BASE)).toBe("https://example.com/feed/post/1");
  expect(safeHttpUrl("/root", BASE)).toBe("https://example.com/root");
  expect(safeHttpUrl("../up", BASE)).toBe("https://example.com/up");
});

test("resolves a protocol-relative URL by inheriting the base scheme", () => {
  expect(safeHttpUrl("//other.org/path", BASE)).toBe("https://other.org/path");
});

test("returns empty for an empty value", () => {
  expect(safeHttpUrl("", BASE)).toBe("");
});

test("rejects script-bearing schemes a hostile feed might inject", () => {
  for (const hostile of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "blob:https://example.com/uuid",
  ]) {
    expect(safeHttpUrl(hostile, BASE)).toBe("");
  }
});

test("returns empty when neither an absolute nor a relative parse succeeds", () => {
  expect(safeHttpUrl("http://", BASE)).toBe("");
  expect(safeHttpUrl("post/1", "not a base")).toBe("");
});

test("rejects a URL whose resolved scheme is not http(s)", () => {
  expect(safeHttpUrl("file.txt", "ftp://example.com/dir")).toBe("");
});

test("keeps the app's own /article/ paths verbatim", () => {
  expect(safeArticleUrl("/article/abc-123", BASE)).toBe("/article/abc-123");
});

test("falls back to safeHttpUrl for anything not starting with /article/", () => {
  expect(safeArticleUrl("javascript:alert(1)", BASE)).toBe("");
  expect(safeArticleUrl("//evil.example/pwn", BASE)).toBe(
    "https://evil.example/pwn",
  );
  expect(safeArticleUrl("post/1", BASE)).toBe(
    "https://example.com/feed/post/1",
  );
});

test("does not treat an /article/ prefix deeper in the path as an article link", () => {
  expect(safeArticleUrl("blog/article/x", BASE)).toBe(
    "https://example.com/feed/blog/article/x",
  );
});

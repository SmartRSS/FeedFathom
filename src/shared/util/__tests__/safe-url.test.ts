import { expect, test } from "bun:test";
import {
  httpUrlWithoutCredentials,
  safeArticleUrl,
  safeHttpUrl,
  secureOrigin,
} from "#shared/util/safe-url.ts";

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

// No route serves these, so a link to one would open "Page not found".
test("gives a newsletter article's /article/ path no link", () => {
  expect(safeArticleUrl("/article/abc-123", BASE)).toBe("");
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

test.each(["https://example.com/story", "http://example.com/a?b#c"])(
  "httpUrlWithoutCredentials accepts %s",
  (value) => {
    expect(httpUrlWithoutCredentials(value)?.href).toBe(value);
  },
);

test.each([
  "ftp://example.com/",
  "javascript:alert(1)",
  "https://user@example.com/",
  "https://user:secret@example.com/",
  "/relative-without-base",
])("httpUrlWithoutCredentials refuses %s", (value) => {
  expect(httpUrlWithoutCredentials(value)).toBeUndefined();
});

test.each([
  ["https://example.com", "https://example.com"],
  ["https://EXAMPLE.com:443/", "https://example.com"],
  ["http://localhost:3456", "http://localhost:3456"],
  ["http://dev.localhost:3456/", "http://dev.localhost:3456"],
  ["http://127.0.0.2:3456", "http://127.0.0.2:3456"],
  ["http://[::1]:3456", "http://[::1]:3456"],
])("secureOrigin accepts %s", (value, expected) => {
  expect(secureOrigin(value)).toBe(expected);
});

test.each([
  "http://example.com",
  "http://localhost.example.com",
  "ftp://example.com",
  "mailto:user@example.com",
  "https://user:password@example.com",
  "https://example.com/path",
  "https://example.com/?",
  "https://example.com/#fragment",
  "not a URL",
])("secureOrigin refuses %s", (value) => {
  expect(secureOrigin(value)).toBeUndefined();
});

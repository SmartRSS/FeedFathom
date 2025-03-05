import { rewriteLinks } from "../src/lib/rewrite-links";
import { describe, expect, test } from "bun:test";

describe("fixLinks", () => {
  test("should convert relative URLs to absolute URLs", () => {
    const content = '<a href="/relative/path">Link</a>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('href="https://example.com/relative/path"');
  });

  test("should add target='_blank' to anchor tags with valid URLs", () => {
    const content = '<a href="https://external.com">External Link</a>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('target="_blank"');
  });

  test("should handle srcset attributes correctly", () => {
    const content = '<img srcset="/image1.jpg 1x, /image2.jpg 2x" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain(
      'srcset="https://example.com/image1.jpg 1x, https://example.com/image2.jpg 2x"',
    );
  });

  test("should not change absolute URLs", () => {
    const content = '<a href="https://already.absolute.com">Link</a>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('href="https://already.absolute.com"');
  });

  test("should handle <img> tags correctly", () => {
    const content = '<img src="/image.jpg" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('src="https://example.com/image.jpg"');
  });

  test("should handle <audio> tags correctly", () => {
    const content = '<audio src="/audio.mp3"></audio>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('src="https://example.com/audio.mp3"');
  });

  test("should handle <video> tags correctly", () => {
    const content = '<video src="/video.mp4" poster="/poster.jpg"></video>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('src="https://example.com/video.mp4"');
    expect(result).toContain('poster="https://example.com/poster.jpg"');
  });

  test("should return empty string for empty content", () => {
    const content = "";
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toBe("");
  });

  test("should handle <link> tags correctly", () => {
    const content = '<link href="/styles.css" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('href="https://example.com/styles.css"');
  });

  test("should handle <source> tags correctly", () => {
    const content = '<source src="/video.mp4" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('src="https://example.com/video.mp4"');
  });

  test("should handle <picture> tags correctly", () => {
    const content =
      '<picture><source srcset="/image1.jpg 1x, /image2.jpg 2x" /></picture>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain(
      'srcset="https://example.com/image1.jpg 1x, https://example.com/image2.jpg 2x"',
    );
  });

  test("should handle multiple tags in the same content", () => {
    const content = '<a href="/relative/path">Link</a><img src="/image.jpg" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('href="https://example.com/relative/path"');
    expect(result).toContain('src="https://example.com/image.jpg"');
  });

  test("should handle malformed HTML gracefully", () => {
    const content = '<a href="/relative/path"><img src="/image.jpg"></a>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('href="https://example.com/relative/path"');
    expect(result).toContain('src="https://example.com/image.jpg"');
  });

  test("should convert relative URLs to absolute URLs based on articleUrl", () => {
    const content = '<a href="../relative/path">Link</a>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('href="https://example.com/relative/path"');
  });

  test("should handle nested relative URLs correctly", () => {
    const content =
      '<a href="./nested/path">Link</a><a href="./nested2/path">Link</a>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('href="https://example.com/nested/path"');
    expect(result).toContain('href="https://example.com/nested2/path"');
  });

  test("should handle multiple relative URLs in the same content", () => {
    const content = '<a href="../path1">Link1</a><a href="./path2">Link2</a>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('href="https://example.com/path1"');
    expect(result).toContain('href="https://example.com/path2"');
  });

  test("should handle relative URLs with query parameters", () => {
    const content = '<a href="/path?query=1">Link</a>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('href="https://example.com/path?query=1"');
  });

  test("should handle relative URLs with fragments", () => {
    const content = '<a href="/path#section">Link</a>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('href="https://example.com/path#section"');
  });

  test("should handle relative URLs in srcset attributes based on articleUrl", () => {
    const content = '<img srcset="../image1.jpg 1x, ../image2.jpg 2x" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain(
      'srcset="https://example.com/image1.jpg 1x, https://example.com/image2.jpg 2x"',
    );
  });

  test("should handle nested relative URLs in srcset attributes correctly", () => {
    const content =
      '<img srcset="./nested/image1.jpg 1x, ./nested/image2.jpg 2x" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain(
      'srcset="https://example.com/nested/image1.jpg 1x, https://example.com/nested/image2.jpg 2x"',
    );
  });

  test("should handle multiple relative URLs in srcset attributes", () => {
    const content = '<img srcset="../path1.jpg 1x, ./path2.jpg 2x" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain(
      'srcset="https://example.com/path1.jpg 1x, https://example.com/path2.jpg 2x"',
    );
  });

  test("should handle relative URLs with query parameters in srcset", () => {
    const content = '<img srcset="/path?query=1 1x" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('srcset="https://example.com/path?query=1 1x"');
  });

  test("should handle relative URLs with fragments in srcset", () => {
    const content = '<img srcset="/path#section 1x" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('srcset="https://example.com/path#section 1x"');
  });

  test("should handle poster attribute of <video> tags correctly", () => {
    const content = '<video src="/video.mp4" poster="/poster.jpg"></video>';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain('src="https://example.com/video.mp4"');
    expect(result).toContain('poster="https://example.com/poster.jpg"');
  });

  test("should handle srcset with URLs containing commas", () => {
    const content =
      '<img srcset="https://substackcdn.com/image/fetch/w_424,c_limit,f_webp,q_auto:good,fl_progressive:steep/image.jpg 424w, https://substackcdn.com/image/fetch/w_848,c_limit,f_webp,q_auto:good,fl_progressive:steep/image.jpg 848w" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    // Should not modify absolute URLs but also not break them
    expect(result).toBe(content);
  });

  test("should handle relative URLs with commas in query parameters in srcset", () => {
    const content =
      '<img srcset="/image/fetch/w_424,c_limit,f_webp,q_auto:good/image.jpg 424w, /image/fetch/w_848,c_limit,f_webp/image.jpg 848w" />';
    const articleUrl = "https://example.com/article";
    const result = rewriteLinks(content, articleUrl);
    expect(result).toContain(
      'srcset="https://example.com/image/fetch/w_424,c_limit,f_webp,q_auto:good/image.jpg 424w, https://example.com/image/fetch/w_848,c_limit,f_webp/image.jpg 848w"',
    );
  });
});

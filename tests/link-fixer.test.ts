import { expect, test, describe } from "bun:test";
import { linkFixer } from "../src/lib/link-fixer.ts";

describe("fixupLinks", () => {
  test('should add target="_blank" to anchor tags with valid href', () => {
    const inputHtml = '<a href="http://example.com">Example</a>';
    const expectedOutput =
      '<a href="http://example.com" target="_blank">Example</a>';
    const result = linkFixer(inputHtml, "http://baseurl.com");
    console.log(result);
    expect(result).toBe(expectedOutput);
  });

  // test('should not add target="_blank" to anchor tags with invalid href', () => {
  //   const inputHtml = '<a href="invalid-url">Invalid</a>';
  //   const expectedOutput = '<a href="invalid-url">Invalid</a>';
  //   const result = linkFixer(inputHtml, "http://baseurl.com");
  //   expect(result).toBe(expectedOutput);
  // });

  test("should process srcset attributes correctly", () => {
    const inputHtml =
      '<img src="image.jpg" srcset="image-1x.jpg 1x, image-2x.jpg 2x">';
    const expectedOutput =
      '<img src="http://baseurl.com/image.jpg" srcset="http://baseurl.com/image-1x.jpg 1x, http://baseurl.com/image-2x.jpg 2x">';
    const result = linkFixer(inputHtml, "http://baseurl.com");
    expect(result).toBe(expectedOutput);
  });

  test("should handle multiple tags correctly", () => {
    const inputHtml =
      '<a href="http://example.com">Example</a><img src="image.jpg">';
    const expectedOutput =
      '<a href="http://example.com" target="_blank">Example</a><img src="http://baseurl.com/image.jpg">';
    const result = linkFixer(inputHtml, "http://baseurl.com");
    expect(result).toBe(expectedOutput);
  });

  test("should return the original HTML if no links are present", () => {
    const inputHtml = "<div>No links here</div>";
    const expectedOutput = "<div>No links here</div>";
    const result = linkFixer(inputHtml, "http://baseurl.com");
    expect(result).toBe(expectedOutput);
  });
});

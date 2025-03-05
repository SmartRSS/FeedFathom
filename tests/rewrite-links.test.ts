import { rewriteLinks } from "../src/lib/rewrite-links";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type TestCase = {
  content: string;
  description: string;
  expected: string;
};

describe("rewriteLinks", () => {
  const articleUrl = "https://example.com/article";
  const files = readdirSync("./tests/rewrite-links/cases")
    .filter((file) => {
      return file.endsWith(".json");
    })
    .sort((a, b) => {
      return a.localeCompare(b);
    });

  for (const file of files) {
    const content = readFileSync(join("tests/rewrite-links/cases", file), "utf8");
    const testCase = JSON.parse(content) as TestCase;

    test(testCase.description, () => {
      const result = rewriteLinks(testCase.content, articleUrl);
      expect(result).toBe(testCase.expected);
    });
  }
});

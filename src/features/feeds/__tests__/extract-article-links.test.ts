import { Type } from "typebox";
import Schema from "typebox/schema";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractArticle } from "#features/feeds/extract-article.ts";

const testCaseSchema = Type.Object(
  {
    content: Type.String(),
    description: Type.String(),
    expected: Type.String(),
  },
  { additionalProperties: false },
);
const testCaseCheck = Schema.Compile(testCaseSchema);
const casesDir = join(import.meta.dir, "extract-article-links-cases");

describe("extractArticle with a base URL", () => {
  const articleUrl = "https://example.com/article";
  const files = readdirSync(casesDir)
    .filter((file) => {
      return file.endsWith(".json");
    })
    .toSorted((a, b) => {
      return a.localeCompare(b);
    });

  for (const file of files) {
    const content = readFileSync(join(casesDir, file), "utf8");
    const testCase: unknown = JSON.parse(content);
    if (!testCaseCheck.Check(testCase)) {
      throw new Error(`Invalid extract-article-links fixture: ${file}`);
    }

    test(testCase.description, () => {
      expect(extractArticle(testCase.content, articleUrl)).toBe(
        extractArticle(testCase.expected),
      );
    });
  }
});

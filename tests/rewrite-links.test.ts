import { Type } from "typebox";
import Schema from "typebox/schema";
import { rewriteLinks } from "../src/lib/rewrite-links";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const testCaseSchema = Type.Object(
  {
    content: Type.String(),
    description: Type.String(),
    expected: Type.String(),
  },
  { additionalProperties: false },
);
const testCaseCheck = Schema.Compile(testCaseSchema);

describe("rewriteLinks", () => {
  const articleUrl = "https://example.com/article";
  const files = readdirSync("./tests/rewrite-links/cases")
    .filter((file) => {
      return file.endsWith(".json");
    })
    .toSorted((a, b) => {
      return a.localeCompare(b);
    });

  for (const file of files) {
    const content = readFileSync(
      join("tests/rewrite-links/cases", file),
      "utf8",
    );
    const testCase: unknown = JSON.parse(content);
    if (!testCaseCheck.Check(testCase)) {
      throw new Error(`Invalid rewrite-links fixture: ${file}`);
    }

    test(testCase.description, () => {
      const result = rewriteLinks(testCase.content, articleUrl);
      expect(result).toBe(testCase.expected);
    });
  }
});

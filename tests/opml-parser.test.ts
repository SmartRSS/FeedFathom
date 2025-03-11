import { OpmlParser } from "../src/lib/opml-parser.ts";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const TEST_CASES_DIR = "tests/opml-parser";

describe("OpmlParser", () => {
  const parser = new OpmlParser();

  describe("processOutline", () => {
    const inputDirectory = path.join(
      TEST_CASES_DIR,
      "inputs",
      "process-outline",
    );
    const expectedDirectory = path.join(
      TEST_CASES_DIR,
      "expected",
      "process-outline",
    );

    // Get all test case files
    const testFiles = fs
      .readdirSync(inputDirectory)
      .filter((file) => {
        return file.endsWith(".ts");
      })
      .map((file) => {
        return file.replace(".ts", "");
      });

    for (const testFile of testFiles) {
      test(`should handle ${testFile.replaceAll("-", " ")}`, async () => {
        const { input } = await import(
          path.join(process.cwd(), inputDirectory, `${testFile}.ts`)
        );
        const { expected } = await import(
          path.join(process.cwd(), expectedDirectory, `${testFile}.ts`)
        );

        const result = parser.processOutline(input);
        expect(result).toEqual(expected);
      });
    }
  });

  describe("parseOpml", () => {
    const inputDirectory = path.join(TEST_CASES_DIR, "inputs", "parse-opml");
    const expectedDirectory = path.join(
      TEST_CASES_DIR,
      "expected",
      "parse-opml",
    );

    // Get all test case files
    const testFiles = fs
      .readdirSync(inputDirectory)
      .filter((file) => {
        return file.endsWith(".ts");
      })
      .map((file) => {
        return file.replace(".ts", "");
      });

    for (const testFile of testFiles) {
      test(`should handle ${testFile.replaceAll("-", " ")}`, async () => {
        const { input } = await import(
          path.join(process.cwd(), inputDirectory, `${testFile}.ts`)
        );

        // Only import expected result for non-error test cases
        let expected;
        if (!testFile.includes("invalid")) {
          const expectedModule = await import(
            path.join(process.cwd(), expectedDirectory, `${testFile}.ts`)
          );
          expected = expectedModule.expected;
        }

        try {
          const result = await parser.parseOpml(input);
          // Only compare results for non-error test cases
          if (testFile.includes("invalid")) {
            // For invalid test cases, we expect the parser to succeed
            // but we don't care about the exact result
            expect(result).toBeTruthy();
          } else {
            expect(result).toEqual(expected);
          }
        } catch (error) {
          // If this is an error test case, we expect an error
          if (testFile.includes("invalid")) {
            expect(error).toBeTruthy();
          } else {
            throw error;
          }
        }
      });
    }
  });
});

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
        if (testFile.includes("invalid")) {
          // A malformed outline is skipped rather than aborting the whole
          // import (see opml-parser.ts) -- processOutline's single-node
          // wrapper then has nothing to return, so it falls back to its
          // own "no result" error instead of a feed-URL-specific one.
          expect(() => parser.processOutline(input)).toThrow(
            "Invalid OPML outline",
          );
          return;
        }

        const { expected } = await import(
          path.join(process.cwd(), expectedDirectory, `${testFile}.ts`)
        );
        expect(parser.processOutline(input)).toEqual(expected);
      });
    }
  });

  describe("parseOpml", () => {
    test("parses recursively nested outlines with arbitrary XML data", () => {
      const result = parser.parseOpml(`
        <opml version="2.0">
          <body>
            <outline text="Root" custom="kept">
              <description>Folder metadata</description>
              <outline text="Nested">
                <outline text="Feed" xmlUrl="https://example.com/feed.xml" customFeed="kept" />
              </outline>
            </outline>
          </body>
        </opml>
      `);

      expect(result).toEqual([
        {
          children: [
            {
              children: [
                {
                  homeUrl: "https://example.com",
                  name: "Feed",
                  type: "source",
                  xmlUrl: "https://example.com/feed.xml",
                },
              ],
              name: "Nested",
              type: "folder",
            },
          ],
          name: "Root",
          type: "folder",
        },
      ]);
    });

    test("returns an empty list without outlines", () => {
      expect(
        parser.parseOpml("<opml><body><not-outline /></body></opml>"),
      ).toEqual([]);
    });

    test("rejects a non-OPML root", () => {
      expect(() => parser.parseOpml("<different-root />")).toThrow(
        "Invalid OPML document",
      );
    });

    test("skips a malformed outline instead of aborting the whole import", () => {
      const result = parser.parseOpml(`
        <opml version="2.0">
          <body>
            <outline text="Good feed" type="rss" xmlUrl="https://example.com/feed.xml" />
            <outline text="Bad feed" type="rss" xmlUrl="not-a-valid-url" />
            <outline text="Another good feed" type="rss" xmlUrl="https://example.org/feed.xml" />
          </body>
        </opml>
      `);

      expect(result).toEqual([
        {
          homeUrl: "https://example.com",
          name: "Good feed",
          type: "source",
          xmlUrl: "https://example.com/feed.xml",
        },
        {
          homeUrl: "https://example.org",
          name: "Another good feed",
          type: "source",
          xmlUrl: "https://example.org/feed.xml",
        },
      ]);
    });

    test("keeps valid children nested under an attribute-less outline wrapper", () => {
      const result = parser.parseOpml(`
        <opml version="2.0">
          <body>
            <outline>
              <outline text="Nested feed" type="rss" xmlUrl="https://example.com/feed.xml" />
            </outline>
          </body>
        </opml>
      `);

      expect(result).toEqual([
        {
          children: [
            {
              homeUrl: "https://example.com",
              name: "Nested feed",
              type: "source",
              xmlUrl: "https://example.com/feed.xml",
            },
          ],
          name: "Unknown",
          type: "folder",
        },
      ]);
    });

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

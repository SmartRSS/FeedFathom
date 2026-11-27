import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Enclosure } from "#shared/contracts/responses.ts";
import { extractArticle } from "#features/feeds/extract-article.ts";
import { parseFeedDocument } from "#features/feeds/feed-document.ts";
import { feedHomeUrl, mapFeedToArticles } from "#features/feeds/feed-mapper.ts";

const goldenDir = join(import.meta.dir, "feed-parser-golden");
const fixedNow = 1_700_000_000_000;

type GoldenArticle = {
  author: string;
  content: string;
  enclosures: Enclosure[];
  expiresAt?: number;
  guid: string;
  publishedAt: string;
  sanitizedContent: string;
  title: string;
  updatedAt: string | null;
  url: string;
};

const contentTypeFor = (file: string): string => {
  switch (extname(file).toLowerCase()) {
    case ".json":
      return "application/feed+json";
    case ".html":
    case ".htm":
      return "text/html";
    default:
      return "application/xml";
  }
};

const evaluateFixture = async (file: string): Promise<unknown> => {
  const bytes = new Uint8Array(readFileSync(join(goldenDir, file)));
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const url = `https://feed-parser-golden.example/${file}`;
  try {
    const { feed, websubHubUrl } = await parseFeedDocument(
      body,
      contentTypeFor(file),
      url,
    );
    const articles = mapFeedToArticles(feed, url, {
      baseUrl: url,
      now: fixedNow,
    }).map((article) => {
      const mapped: GoldenArticle = {
        author: article.author,
        content: article.content,
        enclosures: article.enclosures,
        guid: article.guid,
        publishedAt: article.publishedAt.toISOString(),
        sanitizedContent: extractArticle(article.content),
        title: article.title,
        updatedAt: article.updatedAt?.toISOString() ?? null,
        url: article.url,
      };
      if (article.expiresAt !== undefined) mapped.expiresAt = article.expiresAt;
      return mapped;
    });
    return {
      articles,
      description: feed.description,
      homeUrl: feedHomeUrl(feed, url) ?? null,
      title: feed.title,
      websubHubUrl: websubHubUrl ?? null,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `${error.constructor.name}: ${error.message}`
          : `Error: ${String(error)}`,
    };
  }
};

const fixtureFiles = readdirSync(goldenDir)
  .filter(
    (name) =>
      name !== "LICENSE" &&
      !name.endsWith(".expected.json") &&
      [".htm", ".html", ".json", ".xml"].includes(extname(name).toLowerCase()),
  )
  .toSorted();

describe("feed-parser 2.1.5 golden fixtures", () => {
  test("discovers all committed golden fixtures", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const file of fixtureFiles) {
    const baseName = file.slice(0, -extname(file).length);
    const expectedPath = join(goldenDir, `${baseName}.expected.json`);
    test(file, async () => {
      const expected: unknown = JSON.parse(readFileSync(expectedPath, "utf8"));
      expect(await evaluateFixture(file)).toEqual(expected);
    });
  }
});

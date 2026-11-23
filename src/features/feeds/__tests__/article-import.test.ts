import { expect, test } from "bun:test";
import type { ArticleInsert } from "#platform/db/schemas/articles.ts";
import { ArticleImporter } from "../article-import.ts";

const importer = (changed: number) => {
  const recounted: number[][] = [];
  const stored: ArticleInsert[] = [];
  const instance = new ArticleImporter(
    {
      batchUpsertArticles: async (rows) => {
        stored.push(...rows);
        return changed;
      },
    },
    {
      recomputeUnreadCounts: async (ids: number[]) => {
        recounted.push(ids);
      },
    },
    { publish: () => {} },
    { successSource: async () => {} },
  );
  return { instance, recounted, stored };
};

const article = (guid: string, expiresAt?: number) => ({
  author: "Author",
  content: "",
  enclosures: [],
  guid,
  publishedAt: new Date("2026-10-01T00:00:00Z"),
  title: guid,
  updatedAt: null,
  url: "https://example.com/" + guid,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

test("alwaysRecount recounts a retried import that changes no row", async () => {
  const { instance, recounted } = importer(0);
  await instance.recordFetch(1, [], {
    alwaysRecount: true,
    cached: false,
    trigger: "manual",
  });
  expect(recounted).toEqual([[1]]);
});

test("a recorded fetch leaves out an alert that has already expired", async () => {
  const { instance, stored } = importer(2);
  await instance.recordFetch(
    5,
    [
      article("current"),
      article("expired alert", Date.now() - 1),
      article("live alert", Date.now() + 60_000),
    ],
    { cached: true, trigger: "poll" },
  );

  expect(stored.map(({ guid }) => guid)).toEqual(["current", "live alert"]);
  expect(stored.every((row) => !("expiresAt" in row))).toBe(true);
});

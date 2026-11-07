import { expect, test } from "bun:test";
import type { ArticleInsert } from "#platform/db/schemas/articles.ts";
import type { SourcesDataService } from "../source-data-service.ts";
import { ArticleImporter } from "../article-import.ts";

const importer = (changed: number) => {
  const recounted: number[][] = [];
  const stored: ArticleInsert[] = [];
  const successes: Parameters<SourcesDataService["successSource"]>[] = [];
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
    {
      successSource: async (...args) => {
        successes.push(args);
      },
    },
  );
  return { instance, recounted, stored, successes };
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

// Retention reads an article stamped earlier than its source's last success
// as gone from the feed, so one fetch must stamp both with the same instant.
test("a recorded fetch stamps its articles and the source's success alike", async () => {
  const { instance, stored, successes } = importer(2);
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
  const observedAt = successes[0]?.[1]?.observedAt;
  expect(observedAt).toBeInstanceOf(Date);
  expect(stored.map((row) => row.lastSeenInFeedAt)).toEqual([
    observedAt,
    observedAt,
  ]);
});

import { expect, test } from "bun:test";
import { ArticleImporter } from "../article-import.ts";

const importer = (changed: number) => {
  const recounted: number[][] = [];
  const instance = new ArticleImporter(
    { batchUpsertArticles: async () => changed },
    {
      recomputeUnreadCounts: async (ids: number[]) => {
        recounted.push(ids);
      },
    },
    { publish: () => {} },
  );
  return { instance, recounted };
};

test("an import that changes no row skips the recount", async () => {
  const { instance, recounted } = importer(0);
  await instance.importArticles(1, []);
  expect(recounted).toEqual([]);
});

test("alwaysRecount recounts a retried import that changes no row", async () => {
  const { instance, recounted } = importer(0);
  await instance.importArticles(1, [], { alwaysRecount: true });
  expect(recounted).toEqual([[1]]);
});

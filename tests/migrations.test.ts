import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import journal from "../drizzle/meta/_journal.json";

test("lists every SQL migration in the Drizzle journal", async () => {
  const files = await readdir(new URL("../drizzle", import.meta.url));
  const migrations = files
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .map((file) => file.replace(/\.sql$/, ""))
    .toSorted();
  const journalTags = journal.entries.map((entry) => entry.tag).toSorted();

  expect(journalTags).toEqual(migrations);
});

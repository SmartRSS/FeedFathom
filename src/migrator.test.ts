import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { migrateDatabase, parseConcurrentIndexes } from "./migrator.ts";
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

// The migrator must survive losing the startup race with PostgreSQL rather
// than exiting on the first refused connection -- compose.yml and
// deploy/stack.yml both depend on that, and Swarm arranges no ordering at
// all. Nothing is listening on this port, so every attempt is refused
// immediately; taking longer than one interval proves it retried instead of
// giving up, and still rejecting proves it gives up eventually.
test("retries an unreachable database until its deadline, then fails", async () => {
  const started = Date.now();

  await expect(
    migrateDatabase(
      "postgresql://postgres:postgres@127.0.0.1:1/absent",
      "./drizzle",
      2_500,
    ),
  ).rejects.toThrow();

  expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
});

// The prebuild pass exists so a populated table does not take an ACCESS
// EXCLUSIVE lock for the length of an index build, and it is driven entirely
// by which migrations were written with `CREATE INDEX IF NOT EXISTS`. Pinned
// against a fixture rather than the migration folder, because the folder is
// squashed to a baseline that legitimately has nothing to pre-build -- a
// pattern that silently stopped matching would sail past a test asserting
// "no results" on it.
test("recognises only the statements a migration opted in", () => {
  const parsed = parseConcurrentIndexes(`
    CREATE TABLE "widgets" ("id" serial PRIMARY KEY NOT NULL);
    --> statement-breakpoint
    CREATE INDEX "widgets_plain_idx" ON "widgets" USING btree ("id");
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS "widgets_opted_in_idx" ON "widgets" USING btree ("id","name");
  `);

  expect(parsed).toEqual([
    {
      create:
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "widgets_opted_in_idx" ON "widgets" USING btree ("id","name")',
      name: "widgets_opted_in_idx",
      table: "widgets",
    },
  ]);
});

// The baseline creates every table in the same migration, so every index in
// it lands on an empty table and none should be pre-built. This is what
// makes the pass a no-op today; it exists for the migrations that come next.
test("finds nothing to pre-build in the squashed baseline", async () => {
  const found = (
    await Promise.all(
      journal.entries.map(async (entry) =>
        parseConcurrentIndexes(
          await Bun.file(
            new URL(`../drizzle/${entry.tag}.sql`, import.meta.url).pathname,
          ).text(),
        ),
      ),
    )
  ).flat();

  expect(found).toEqual([]);
});

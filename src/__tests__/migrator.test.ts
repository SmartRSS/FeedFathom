import { expect, spyOn, test } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  migrateDatabase,
  parseConcurrentDrops,
  parseConcurrentIndexes,
} from "../migrator.ts";
import journal from "../../drizzle/meta/_journal.json";

test("lists every SQL migration in the Drizzle journal", async () => {
  const files = await readdir(new URL("../../drizzle", import.meta.url));
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
// immediately.
test("retries an unreachable database until its deadline, then fails", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    await expect(
      migrateDatabase(
        "postgresql://postgres:postgres@127.0.0.1:1/absent",
        "./drizzle",
        { deadline: 200, interval: 10 },
      ),
    ).rejects.toThrow();

    const retries = log.mock.calls.filter(([line]) =>
      String(line).includes("retrying"),
    );
    expect(retries.length).toBeGreaterThan(1);
  } finally {
    log.mockRestore();
  }
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

test("pre-drops only the indexes a migration opted in", () => {
  expect(
    parseConcurrentDrops(`
      DROP INDEX "widgets_plain_idx";
      --> statement-breakpoint
      DROP INDEX IF EXISTS "widgets_opted_in_idx";
    `),
  ).toEqual(["widgets_opted_in_idx"]);
});

const migrationStatements = async () =>
  (
    await Promise.all(
      journal.entries.map(async (entry) =>
        Bun.file(
          new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url).pathname,
        ).text(),
      ),
    )
  ).join("\n");

// Every statement a migration opted in is one the parser recognises, so a
// migration whose opt-in the pattern misses fails here rather than taking an
// ACCESS EXCLUSIVE lock on a populated table in production.
test("recognises every index a migration in the folder opted in", async () => {
  const statements = await migrationStatements();
  expect(parseConcurrentIndexes(statements)).toHaveLength(
    statements.match(/CREATE INDEX IF NOT EXISTS/g)?.length ?? 0,
  );
  expect(parseConcurrentDrops(statements)).toHaveLength(
    statements.match(/DROP INDEX IF EXISTS/g)?.length ?? 0,
  );
});

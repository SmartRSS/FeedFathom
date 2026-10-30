import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { migrateDatabase } from "../../../migrator.ts";

const migrationsFolder = fileURLToPath(
  new URL("../../../../drizzle", import.meta.url),
);
const databaseUrl = requireDisposableDatabaseUrl();
const client = new SQL(databaseUrl);
const drizzleConnection = createDrizzleConnection(databaseUrl);
const sourcesDataService = new SourcesDataService(drizzleConnection);

// Inserted in this order, so ids ascend down the list. Every column has a tie
// somewhere, which only the id tie-break settles.
const rows = [
  ["https://b.test/", "2026-01-02", 0, 2],
  ["https://a.test/", "2026-01-01", 3, 0],
  ["https://c.test/", "2026-01-02", 0, 1],
  ["https://a.test/2", "2026-01-03", 3, 2],
] as const;

beforeAll(async () => {
  await client`DROP SCHEMA IF EXISTS "drizzle" CASCADE`;
  await client`DROP SCHEMA IF EXISTS "public" CASCADE`;
  await client`CREATE SCHEMA "public"`;
  await migrateDatabase(databaseUrl, migrationsFolder);
  const [user] = await client<{ id: number }[]>`
    INSERT INTO users (email, name, password)
    VALUES ('admin@example.test', 'admin', 'x') RETURNING id`;
  const [other] = await client<{ id: number }[]>`
    INSERT INTO users (email, name, password)
    VALUES ('other@example.test', 'other', 'x') RETURNING id`;
  for (const [url, day, failures, subscribers] of rows) {
    // eslint-disable-next-line no-await-in-loop -- Insertion order sets the ids.
    const [source] = await client<{ id: number }[]>`
      INSERT INTO sources (url, home_url, created_at, last_attempt,
        last_success, recent_failures)
      VALUES (${url}, ${url}, ${day}::timestamptz, ${day}::timestamptz,
        ${day}::timestamptz, ${failures})
      RETURNING id`;
    for (const subscriber of [user, other].slice(0, subscribers)) {
      // eslint-disable-next-line no-await-in-loop -- Two rows at most.
      await client`
        INSERT INTO user_sources (user_id, source_id, name)
        VALUES (${subscriber!.id}, ${source!.id}, 'sub')`;
    }
  }
});

afterAll(async () => {
  await drizzleConnection.$client.close();
  await client.close();
});

// Expected orders by insertion index; ties fall back to ascending id in both
// directions, so a reload of the admin table never reshuffles tied rows.
test.each([
  ["createdAt", "asc", [1, 0, 2, 3]],
  ["createdAt", "desc", [3, 0, 2, 1]],
  ["lastAttempt", "asc", [1, 0, 2, 3]],
  ["lastSuccess", "desc", [3, 0, 2, 1]],
  ["recentFailures", "asc", [0, 2, 1, 3]],
  ["recentFailures", "desc", [1, 3, 0, 2]],
  ["subscriberCount", "asc", [1, 2, 0, 3]],
  ["subscriberCount", "desc", [0, 3, 2, 1]],
  ["url", "asc", [1, 3, 0, 2]],
  ["url", "desc", [2, 0, 3, 1]],
] as const)(
  "lists sources by %s %s, then by id",
  async (sortBy, order, expected) => {
    const listed = await sourcesDataService.listAllSources(sortBy, order);

    expect(listed.map((source) => source.url)).toEqual(
      expected.map((index) => rows[index][0]),
    );
  },
);

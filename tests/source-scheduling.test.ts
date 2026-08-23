import { expect, test } from "bun:test";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { SourcesDataService } from "../src/db/data-services/source-data-service.ts";
import { migrateDatabase } from "../src/migrator.ts";

function requireDisposableDatabaseUrl() {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !/(?:^|[_-])(?:disposable|migration_test|test)(?:[_-]|$)/i.test(
      databaseName,
    )
  ) {
    throw new Error(
      "DATABASE_URL must target a clearly disposable PostgreSQL database whose name includes a test or disposable marker",
    );
  }
  return databaseUrl;
}

const databaseUrl = requireDisposableDatabaseUrl();
// A short connect deadline, because the production default is two minutes
// of retrying -- right for a container racing PostgreSQL's first boot, and
// two minutes of nothing for a developer who simply has no PostgreSQL
// running.
await migrateDatabase(databaseUrl, "./drizzle", 5_000);
const drizzleConnection = createDrizzleConnection(databaseUrl);
const noopQueue = { async add() {} };
const sourcesDataService = new SourcesDataService(drizzleConnection, noopQueue);

async function addFeedSource(url: string) {
  return await sourcesDataService.addSource({
    homeUrl: url,
    kind: "feed",
    url,
  });
}

test("successSource clamps notBefore to the 5-minute floor even for a shorter cache lifetime", async () => {
  const source = await addFeedSource(
    "https://source-scheduling.test/short-cache",
  );
  const before = Date.now();
  await sourcesDataService.successSource(source.id, false, new Date());

  const refreshed = await sourcesDataService.findSourceById(source.id);
  expect(refreshed?.notBefore?.getTime()).toBeGreaterThanOrEqual(
    before + 5 * 60_000,
  );
});

test("successSource honors a cache lifetime longer than the floor", async () => {
  const source = await addFeedSource(
    "https://source-scheduling.test/long-cache",
  );
  const notBefore = new Date(Date.now() + 60 * 60_000);
  await sourcesDataService.successSource(source.id, false, notBefore);

  const refreshed = await sourcesDataService.findSourceById(source.id);
  expect(refreshed?.notBefore?.getTime()).toBe(notBefore.getTime());
});

test("failSource backs off further with each consecutive failure", async () => {
  const source = await addFeedSource("https://source-scheduling.test/fails");

  await sourcesDataService.failSource(source.id, "boom");
  const afterFirst = await sourcesDataService.findSourceById(source.id);
  expect(afterFirst?.recentFailures).toBe(1);

  await sourcesDataService.failSource(source.id, "boom again");
  const afterSecond = await sourcesDataService.findSourceById(source.id);
  expect(afterSecond?.recentFailures).toBe(2);
  expect(afterSecond?.notBefore?.getTime()).toBeGreaterThan(
    afterFirst?.notBefore?.getTime() ?? 0,
  );
});

test("getSourcesToProcess only returns feed sources whose notBefore has passed", async () => {
  // A freshly inserted source (never fetched) is due by the column's own
  // default -- notBefore defaults to the Unix epoch, not successSource
  // (which always clamps forward to the floor, so it can't produce "due
  // right now" itself).
  const due = await addFeedSource("https://source-scheduling.test/due");

  const notYetDue = await addFeedSource(
    "https://source-scheduling.test/not-due",
  );
  await sourcesDataService.successSource(
    notYetDue.id,
    false,
    new Date(Date.now() + 60 * 60_000),
  );

  const result = await sourcesDataService.getSourcesToProcess();
  const ids = result.map((row) => row.id);
  expect(ids).toContain(due.id);
  expect(ids).not.toContain(notYetDue.id);
});

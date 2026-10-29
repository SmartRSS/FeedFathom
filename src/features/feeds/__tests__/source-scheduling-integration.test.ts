import { expect, test } from "bun:test";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { users } from "#platform/db/schemas/users.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";

const databaseUrl = requireDisposableDatabaseUrl();
// A short connect deadline, because the production default is two minutes
// of retrying -- right for a container racing PostgreSQL's first boot, and
// two minutes of nothing for a developer who simply has no PostgreSQL
// running.
await migrateDatabase(databaseUrl, "./drizzle", 5_000);
const drizzleConnection = createDrizzleConnection(databaseUrl);
const sourcesDataService = new SourcesDataService(drizzleConnection);

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

// The subscriber count once compared user_sources.source_id with
// user_sources.id, because drizzle left the outer sources.id unqualified.
test("findSourceById and listAllSources count a source's subscribers", async () => {
  const source = await addFeedSource(
    `https://source-scheduling.test/${Bun.randomUUIDv7()}`,
  );
  const subscribers = await drizzleConnection
    .insert(users)
    .values(
      ["a", "b"].map((name) => ({
        email: `${name}-${Bun.randomUUIDv7()}@source-scheduling.test`,
        name,
        password: "x",
      })),
    )
    .returning({ id: users.id });
  await drizzleConnection.insert(userSources).values(
    subscribers.map(({ id }) => ({
      name: "sub",
      parentId: null,
      sourceId: source.id,
      userId: id,
    })),
  );

  expect(
    (await sourcesDataService.findSourceById(source.id))?.subscriberCount,
  ).toBe(2);
  const listed = await sourcesDataService.listAllSources(
    "subscriberCount",
    "desc",
  );
  expect(listed.find(({ id }) => id === source.id)?.subscriberCount).toBe(2);
});

test("getSourcesDueFaviconRefresh picks a source parsed hours before the daily run", async () => {
  const hoursAgo = await addFeedSource("https://source-scheduling.test/hours");
  await sourcesDataService.successSource(
    hoursAgo.id,
    false,
    undefined,
    new Date(Date.now() - 6 * 60 * 60_000),
  );
  const daysAgo = await addFeedSource("https://source-scheduling.test/days");
  await sourcesDataService.successSource(
    daysAgo.id,
    false,
    undefined,
    new Date(Date.now() - 2 * 24 * 60 * 60_000),
  );
  const neverFetched = await addFeedSource(
    "https://source-scheduling.test/never",
  );

  const dueIds = new Set(
    (await sourcesDataService.getSourcesDueFaviconRefresh()).map(
      (source) => source.id,
    ),
  );
  expect(dueIds.has(hoursAgo.id)).toBe(true);
  expect(dueIds.has(daysAgo.id)).toBe(false);
  expect(dueIds.has(neverFetched.id)).toBe(false);
});

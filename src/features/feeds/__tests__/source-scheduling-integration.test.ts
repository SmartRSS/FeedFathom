import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { sources } from "#platform/db/schemas/sources.ts";
import { users } from "#platform/db/schemas/users.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";

const databaseUrl = requireDisposableDatabaseUrl();
await migrateDatabase(databaseUrl, "./drizzle", { deadline: 5_000 });
const drizzleConnection = createDrizzleConnection(databaseUrl);
const sourcesDataService = new SourcesDataService(drizzleConnection);

const fetched = (facts: { notBefore?: Date } = {}) => ({
  cached: false,
  trigger: "poll" as const,
  ...facts,
});

async function succeededAgo(sourceId: number, ms: number) {
  await sourcesDataService.successSource(sourceId, fetched());
  await drizzleConnection
    .update(sources)
    .set({ lastSuccess: new Date(Date.now() - ms) })
    .where(eq(sources.id, sourceId));
}

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
  await sourcesDataService.successSource(
    source.id,
    fetched({ notBefore: new Date() }),
  );

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
  await sourcesDataService.successSource(source.id, fetched({ notBefore }));

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
  const due = await addFeedSource("https://source-scheduling.test/due");

  const notYetDue = await addFeedSource(
    "https://source-scheduling.test/not-due",
  );
  await sourcesDataService.successSource(
    notYetDue.id,
    fetched({ notBefore: new Date(Date.now() + 60 * 60_000) }),
  );

  const result = await sourcesDataService.getSourcesToProcess();
  const ids = result.map((row) => row.id);
  expect(ids).toContain(due.id);
  expect(ids).not.toContain(notYetDue.id);
});

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
  await succeededAgo(hoursAgo.id, 6 * 60 * 60_000);
  const daysAgo = await addFeedSource("https://source-scheduling.test/days");
  await succeededAgo(daysAgo.id, 2 * 24 * 60 * 60_000);
  const neverFetched = await addFeedSource(
    "https://source-scheduling.test/never",
  );
  const email = await sourcesDataService.addSource({
    homeUrl: "https://source-scheduling.test",
    kind: "email",
    url: "newsletter@source-scheduling.test",
  });
  await sourcesDataService.successSource(email.id, fetched());

  const dueIds = new Set(
    (await sourcesDataService.getSourcesDueFaviconRefresh()).map(
      (source) => source.id,
    ),
  );
  expect(dueIds.has(hoursAgo.id)).toBe(true);
  expect(dueIds.has(daysAgo.id)).toBe(false);
  expect(dueIds.has(neverFetched.id)).toBe(false);
  expect(dueIds.has(email.id)).toBe(false);
});

test("getSourcesDueFaviconRefresh lists sources without an icon first", async () => {
  const withIcon = await addFeedSource("https://source-scheduling.test/icon");
  await sourcesDataService.successSource(withIcon.id, fetched());
  await sourcesDataService.updateFavicon(
    withIcon.id,
    Buffer.from("icon"),
    "image/png",
  );
  const withoutIcon = await addFeedSource(
    "https://source-scheduling.test/no-icon",
  );
  await sourcesDataService.successSource(withoutIcon.id, fetched());

  const due = (await sourcesDataService.getSourcesDueFaviconRefresh()).filter(
    ({ id }) => id === withIcon.id || id === withoutIcon.id,
  );
  expect(due).toEqual([
    { hasFavicon: false, homeUrl: withoutIcon.homeUrl, id: withoutIcon.id },
    { hasFavicon: true, homeUrl: withIcon.homeUrl, id: withIcon.id },
  ]);
});

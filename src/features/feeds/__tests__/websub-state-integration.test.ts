import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { sources } from "#platform/db/schemas/sources.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";

const databaseUrl = requireDisposableDatabaseUrl();
await migrateDatabase(databaseUrl, "./drizzle", 5_000);
const drizzleConnection = createDrizzleConnection(databaseUrl);
const sourcesDataService = new SourcesDataService(drizzleConnection);
const websubStateService = new WebSubStateService(drizzleConnection);

const attemptedAgo = async (sourceId: number, interval: string) => {
  await drizzleConnection
    .update(sources)
    .set({
      websubSubscribeAttemptedAt: sql`NOW() - ${interval}::interval`,
    })
    .where(eq(sources.id, sourceId));
};

// Each poll of a pending source used to mint a new token and POST the hub
// again: a hub verifying after the next poll called a dead token, and one
// that never verified got a subscribe request on every poll.
test("a pending subscription keeps its token and is retried only after a day", async () => {
  const topic = `https://websub-state.test/${Bun.randomUUIDv7()}`;
  const source = await sourcesDataService.addSource({
    homeUrl: "https://websub-state.test/",
    kind: "feed",
    url: topic,
  });
  const hub = "https://hub.websub-state.test/";

  expect(await websubStateService.claimWebSubSubscribeAttempt(source.id)).toBe(
    true,
  );
  const first = await websubStateService.recordWebSubDiscovery(
    source.id,
    hub,
    topic,
  );

  await attemptedAgo(source.id, "1 hour");
  expect(await websubStateService.claimWebSubSubscribeAttempt(source.id)).toBe(
    false,
  );

  await attemptedAgo(source.id, "25 hours");
  expect(await websubStateService.claimWebSubSubscribeAttempt(source.id)).toBe(
    true,
  );
  expect(
    await websubStateService.recordWebSubDiscovery(source.id, hub, topic),
  ).toEqual(first);
});

import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDrizzleConnection } from "#platform/db/connection.ts";
import { sources } from "#platform/db/schemas/sources.ts";
import { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { WebSubStateService } from "#features/feeds/websub-state-service.ts";
import { migrateDatabase } from "../../../migrator.ts";
import { requireDisposableDatabaseUrl } from "#platform/db/__tests__/disposable-database-url.ts";

const databaseUrl = requireDisposableDatabaseUrl();
await migrateDatabase(databaseUrl, "./drizzle", { deadline: 5_000 });
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

test("renewal lists verified subscriptions whose lease ends within the renewal interval", async () => {
  const verifiedSource = async (leaseExpiresAt: Date) => {
    const topic = `https://websub-state.test/${Bun.randomUUIDv7()}`;
    const source = await sourcesDataService.addSource({
      homeUrl: "https://websub-state.test/",
      kind: "feed",
      url: topic,
    });
    const recorded = await websubStateService.recordWebSubDiscovery(
      source.id,
      "https://hub.websub-state.test/",
      topic,
    );
    await websubStateService.markWebSubVerified(source.id, leaseExpiresAt);
    return { ...recorded, id: source.id, topic };
  };
  const expiring = await verifiedSource(new Date(Date.now() + 60_000));
  const distant = await verifiedSource(new Date(Date.now() + 365 * 86_400_000));

  const due = await websubStateService.getWebSubSubscriptionsNeedingRenewal();

  expect(due.find((row) => row.id === expiring.id)).toEqual({
    callbackToken: expiring.callbackToken,
    hubUrl: "https://hub.websub-state.test/",
    id: expiring.id,
    secret: expiring.secret,
    topicUrl: expiring.topic,
  });
  expect(due.some((row) => row.id === distant.id)).toBe(false);
});

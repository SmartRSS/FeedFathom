import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { type Source, sources } from "#platform/db/schemas/sources.ts";

/**
 * WebSub subscription lease state on a source: the subscribe-attempt claim,
 * discovery record, verification/failure transitions, callback lookup and the
 * renewal sweep query.
 *
 * Deliberately free of orchestration -- POSTing to the hub stays with the
 * callers (FeedParser, MainWorker); this only owns the columns that make the
 * hub conversation reproducible.
 */
export class WebSubStateService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

  // Generates a fresh per-subscription secret and callback token and moves to
  // "pending"; the caller POSTs to the hub with the returned values, so the
  // two always agree on which secret is current.
  //
  // Also an atomic claim (see the schema comment on
  // websubSubscribeAttemptedAt): returns false when another attempt already
  // claimed this source inside the cooldown, so the caller skips rather than
  // racing a second hub request with a different callback token.
  public async claimWebSubSubscribeAttempt(sourceId: number): Promise<boolean> {
    const claimed = await this.drizzleConnection
      .update(sources)
      .set({ websubSubscribeAttemptedAt: sql`NOW()` })
      .where(
        and(
          eq(sources.id, sourceId),
          or(
            isNull(sources.websubSubscribeAttemptedAt),
            lt(
              sources.websubSubscribeAttemptedAt,
              sql`NOW() - INTERVAL '30 seconds'`,
            ),
          ),
        ),
      )
      .returning({ id: sources.id });
    return claimed.length > 0;
  }

  public async recordWebSubDiscovery(
    sourceId: number,
    hubUrl: string,
    topicUrl: string,
  ): Promise<{ callbackToken: string; secret: string }> {
    const callbackToken = crypto.randomUUID();
    const secret = crypto.randomUUID();
    await this.drizzleConnection
      .update(sources)
      .set({
        websubCallbackToken: callbackToken,
        websubHubUrl: hubUrl,
        websubSecret: secret,
        websubStatus: "pending",
        websubTopicUrl: topicUrl,
      })
      .where(eq(sources.id, sourceId));
    return { callbackToken, secret };
  }

  public async markWebSubVerified(sourceId: number, leaseExpiresAt: Date) {
    await this.drizzleConnection
      .update(sources)
      .set({
        // kind: "websub" drives the reduced cadence in getSourcesToProcess.
        // Delivery isn't guaranteed, so this is a longer fallback interval,
        // not "stop polling".
        kind: "websub",
        websubLeaseExpiresAt: leaseExpiresAt,
        websubStatus: "verified",
      })
      .where(eq(sources.id, sourceId));
  }

  public async markWebSubFailed(sourceId: number) {
    await this.drizzleConnection
      .update(sources)
      .set({
        // Back to ordinary cadence: a dead subscription still marked "websub"
        // would be checked daily with no push to make up for it.
        kind: "feed",
        websubStatus: "failed",
      })
      .where(eq(sources.id, sourceId));
  }

  public async findSourceByWebSubCallbackToken(
    token: string,
  ): Promise<Source | undefined> {
    return (
      await this.drizzleConnection
        .select()
        .from(sources)
        .where(eq(sources.websubCallbackToken, token))
        .limit(1)
    ).at(0);
  }

  // The renewal job runs daily (see MainWorker), so a one-day window
  // guarantees every verified subscription gets an attempt before its lease
  // lapses, even if one day's run is late or fails.
  public async getWebSubSubscriptionsNeedingRenewal() {
    return await this.drizzleConnection
      .select({
        callbackToken: sources.websubCallbackToken,
        hubUrl: sources.websubHubUrl,
        id: sources.id,
        secret: sources.websubSecret,
        topicUrl: sources.websubTopicUrl,
      })
      .from(sources)
      .where(
        and(
          eq(sources.websubStatus, "verified"),
          sql`${sources.websubLeaseExpiresAt} <= NOW() + INTERVAL '1 day'`,
        ),
      );
  }
}

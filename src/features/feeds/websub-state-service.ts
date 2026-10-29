import { type AnyColumn, and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { type Source, sources } from "#platform/db/schemas/sources.ts";

// The column's current value on a pending subscription, else `fresh`.
const pendingOr = (column: AnyColumn, fresh: string) =>
  sql<string>`CASE WHEN ${sources.websubStatus} = 'pending' THEN COALESCE(${column}, ${fresh}) ELSE ${fresh} END`;

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

  // Atomic claim (see the schema comment on websubSubscribeAttemptedAt):
  // returns false when another attempt already claimed this source inside the
  // cooldown, so the caller skips rather than racing a second hub request with
  // a different callback token. A pending subscription waits a day: the hub
  // may still verify the request it has, and one that never does should not
  // get a new request on every poll.
  // ponytail: a flat daily retry; count attempts if a dead hub's daily POST matters.
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
              sql`NOW() - CASE WHEN ${sources.websubStatus} = 'pending' THEN INTERVAL '1 day' ELSE INTERVAL '30 seconds' END`,
            ),
          ),
        ),
      )
      .returning({ id: sources.id });
    return claimed.length > 0;
  }

  // A pending subscription keeps its token and secret, so a hub verifying
  // the earlier request still finds its callback.
  public async recordWebSubDiscovery(
    sourceId: number,
    hubUrl: string,
    topicUrl: string,
  ): Promise<{ callbackToken: string; secret: string }> {
    const [recorded] = await this.drizzleConnection
      .update(sources)
      .set({
        websubCallbackToken: pendingOr(
          sources.websubCallbackToken,
          crypto.randomUUID(),
        ),
        websubHubUrl: hubUrl,
        websubSecret: pendingOr(sources.websubSecret, crypto.randomUUID()),
        websubStatus: "pending",
        websubTopicUrl: topicUrl,
      })
      .where(eq(sources.id, sourceId))
      .returning({
        callbackToken: sources.websubCallbackToken,
        secret: sources.websubSecret,
      });
    if (!recorded?.callbackToken || !recorded.secret)
      throw new Error(`Source ${sourceId} not found`);
    return { callbackToken: recorded.callbackToken, secret: recorded.secret };
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

  // The daily renewal job (see MainWorker) selects verified subscriptions
  // with expired leases or leases expiring within a day. Late or missed runs
  // can let a lease lapse before the next attempt.
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

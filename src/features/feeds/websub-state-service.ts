import {
  type AnyColumn,
  and,
  eq,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { type Source, sources } from "#platform/db/schemas/sources.ts";
import { webSubRenewalIntervalMs } from "#features/feeds/websub-subscriber.ts";

const pendingOr = (column: AnyColumn, fresh: string) =>
  sql<string>`CASE WHEN ${sources.websubStatus} = 'pending' THEN COALESCE(${column}, ${fresh}) ELSE ${fresh} END`;

export class WebSubStateService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

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

  public async getWebSubSubscriptionsNeedingRenewal() {
    return await this.drizzleConnection
      .select({
        callbackToken: sql<string>`${sources.websubCallbackToken}`,
        hubUrl: sql<string>`${sources.websubHubUrl}`,
        id: sources.id,
        secret: sql<string>`${sources.websubSecret}`,
        topicUrl: sql<string>`${sources.websubTopicUrl}`,
      })
      .from(sources)
      .where(
        and(
          eq(sources.websubStatus, "verified"),
          isNotNull(sources.websubCallbackToken),
          isNotNull(sources.websubHubUrl),
          isNotNull(sources.websubSecret),
          isNotNull(sources.websubTopicUrl),
          sql`${sources.websubLeaseExpiresAt} <= NOW() + ${webSubRenewalIntervalMs} * INTERVAL '1 millisecond'`,
        ),
      );
  }
}

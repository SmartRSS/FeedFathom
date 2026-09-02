import { type Static, Type } from "typebox";
import Schema from "typebox/schema";
import { and, eq, getTableColumns, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { dateType } from "#shared/validation/typebox-policy.ts";
import type { sourceSortSchema } from "#shared/contracts/requests.ts";
import { JobName } from "#shared/types/job-name-enum.ts";
import type * as schema from "#platform/db/schema.ts";
import { type Source, sources } from "#platform/db/schemas/sources.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import {
  clampToPollFloor,
  pollFloorMs,
} from "#features/feeds/source-schedule-policy.ts";

type SourceQueue = {
  add(
    name: JobName,
    data: {
      id: number;
      skipCache: boolean;
      trigger?: "manual" | "websub-push";
      url: string;
    },
    options: {
      jobId: string;
      lifo: boolean;
      removeOnComplete: { count: number };
      removeOnFail: { count: number };
    },
  ): Promise<unknown>;
};

export interface SourceWithSubscriberCount {
  id: number;
  url: string;
  homeUrl: string;
  createdAt: Date;
  lastAttempt: Date | null;
  lastFetchTrigger: "email" | "manual" | "poll" | "websub-push" | null;
  lastSuccess: Date | null;
  recentFailures: number;
  subscriberCount: number;
  recentFailureDetails: string;
  websubStatus: "failed" | "none" | "pending" | "verified";
}

// Minimum spacing between successful "feed" polls, regardless of what the
// origin's Cache-Control says -- see successSource's clamp.
// Flat per-tick ceiling, replacing a "10% of whatever is due" throttle that
// self-balanced into a permanent backlog: every source waited ~3.3 extra
// minutes for a slot, stretching a 5-minute cadence to a 7.3-minute observed
// median. Draining what's due is well within capacity and notBefore already
// staggers arrivals, so the flat cap only bounds the pathological case (an
// outage making every source due at once).
const gatherBatchLimit = 500;
const exact = { additionalProperties: false } as const;
type SourceSort = Static<typeof sourceSortSchema>;
// The whole defence for the interpolation in listAllSources: an unrecognised
// key falls back to a literal spelled out here, so nothing caller-supplied
// reaches the SQL text.
const sourceSortSql = new Map([
  ["createdAt", "s.created_at"],
  ["lastAttempt", "s.last_attempt"],
  ["lastSuccess", "s.last_success"],
  ["recentFailures", "s.recent_failures"],
  ["subscriberCount", '"subscriberCount"'],
  ["url", "s.url"],
]);
const sourceOrderSql = new Map([
  ["asc", "ASC"],
  ["desc", "DESC"],
]);
const sourceListRowsSchema = Type.Array(
  Type.Object(
    {
      createdAt: dateType,
      homeUrl: Type.String(),
      id: Type.Integer(),
      lastAttempt: Type.Union([dateType, Type.Null()]),
      lastFetchTrigger: Type.Union([
        Type.Literal("email"),
        Type.Literal("manual"),
        Type.Literal("poll"),
        Type.Literal("websub-push"),
        Type.Null(),
      ]),
      lastSuccess: Type.Union([dateType, Type.Null()]),
      recentFailureDetails: Type.String(),
      recentFailures: Type.Integer(),
      subscriberCount: Type.Integer({ minimum: 0 }),
      url: Type.String(),
      websubStatus: Type.Union([
        Type.Literal("none"),
        Type.Literal("pending"),
        Type.Literal("verified"),
        Type.Literal("failed"),
      ]),
    },
    exact,
  ),
);
const sourceListRowsCheck = Schema.Compile(sourceListRowsSchema);
const sourcesToProcessRowsSchema = Type.Array(
  Type.Object({ id: Type.Integer(), url: Type.String() }, exact),
);
const sourcesToProcessRowsCheck = Schema.Compile(sourcesToProcessRowsSchema);

export function parseSourceListRows(
  value: unknown,
): SourceWithSubscriberCount[] {
  if (!sourceListRowsCheck.Check(value)) {
    throw new Error("Database returned invalid source list rows");
  }
  return value;
}

export function resolveSourceListOrder(sortBy: string, order: string) {
  return {
    order: sourceOrderSql.get(order) ?? "ASC",
    sort: sourceSortSql.get(sortBy) ?? "s.created_at",
  };
}

const isUniqueViolation = (error: unknown, depth = 0): boolean => {
  if (typeof error !== "object" || error === null || depth > 3) return false;
  const code = "code" in error ? error.code : undefined;
  const errno = "errno" in error ? error.errno : undefined;
  if (code === "23505" || errno === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause, depth + 1);
};

export type SourceUrlUpdateResult = "conflict" | "not-found" | "updated";

export class SourcesDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
    private readonly bullmqQueue: SourceQueue,
  ) {}

  public async addSource(payload: {
    homeUrl: string;
    kind?: "email" | "feed" | undefined;
    url: string;
  }): Promise<Source> {
    const inserted = (
      await this.drizzleConnection
        .insert(sources)
        .values(payload)
        .onConflictDoNothing({ target: sources.url })
        .returning()
    ).at(0);
    if (inserted) return inserted;

    const existing = await this.findSourceByUrl(payload.url);
    if (!existing) throw new Error("Source conflict resolved without a row");
    return existing;
  }

  public async enqueueSource(
    source: { id: number; url: string },
    trigger: "manual" | "websub-push" = "manual",
  ) {
    await this.bullmqQueue.add(
      JobName.ParseSource,
      { id: source.id, skipCache: true, trigger, url: source.url },
      {
        jobId: `${JobName.ParseSource}-${source.id}`,
        lifo: true,
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    );
  }

  // subscriberCount rides along for the ParseSource job's User-Agent (see
  // buildUserAgent). A correlated subquery keeps the hot polling path to one
  // round trip.
  public async findSourceById(
    sourceId: number,
  ): Promise<(Source & { subscriberCount: number }) | undefined> {
    return (
      await this.drizzleConnection
        .select({
          ...getTableColumns(sources),
          subscriberCount: sql<number>`(
            SELECT COUNT(*)::int
            FROM ${userSources}
            WHERE ${userSources.sourceId} = ${sources.id}
          )`,
        })
        .from(sources)
        .where(eq(sources.id, sourceId))
        .limit(1)
    ).at(0);
  }

  public async findSourceByUrl(url: string): Promise<Source | undefined> {
    return (
      await this.drizzleConnection
        .select()
        .from(sources)
        .where(eq(sources.url, url))
    ).at(0);
  }

  public async getRecentlySuccessfulSources() {
    return await this.drizzleConnection
      .select({
        homeUrl: sources.homeUrl,
        id: sources.id,
      })
      .from(sources)
      .where(gt(sources.lastSuccess, sql`NOW() - INTERVAL '5 minutes'`));
  }

  // "email" has no endpoint to poll. "feed" is gated purely by notBefore,
  // which successSource/failSource write directly, so nothing is recomputed at
  // read time. "websub" uses a flat daily last_attempt check as a safety net
  // for a dropped push, and ignores notBefore on purpose -- a Cache-Control
  // value from a normal fetch would otherwise pull the next check inside a
  // day and undo the reduced cadence.
  public async getSourcesToProcess() {
    const result: unknown = await this.drizzleConnection.execute(sql`
      WITH "due_sources" AS (
        SELECT ${sources.id} AS "id", ${sources.url} AS "url", ${sources.lastAttempt} AS "last_attempt"
        FROM ${sources}
        WHERE (
          (
            ${sources.kind} = 'feed'
            AND ${sources.notBefore} <= NOW()
          )
          OR (
            ${sources.kind} = 'websub'
            AND (
              ${sources.lastAttempt} IS NULL
              OR ${sources.lastAttempt} < NOW() - INTERVAL '1 day'
            )
          )
        )
      )
      SELECT "id", "url"
      FROM "due_sources"
      ORDER BY "last_attempt" ASC NULLS FIRST
      LIMIT ${gatherBatchLimit}
    `);
    if (!sourcesToProcessRowsCheck.Check(result)) {
      throw new Error("Database returned invalid source processing rows");
    }
    return result;
  }

  public async listAllSources(
    sortBy: SourceSort,
    order: "asc" | "desc",
  ): Promise<SourceWithSubscriberCount[]> {
    const resolved = resolveSourceListOrder(sortBy, order);

    const query = `
        WITH subscriber_counts AS (
            SELECT
                us.source_id,
                COUNT(us.user_id)::int AS count
            FROM user_sources AS us
            GROUP BY us.source_id
        )
        SELECT
            s.id,
            s.url,
            s.home_url as "homeUrl",
            s.created_at as "createdAt",
            s.last_attempt as "lastAttempt",
            s.last_fetch_trigger as "lastFetchTrigger",
            s.last_success as "lastSuccess",
            COALESCE(s.recent_failures, 0) as "recentFailures",
            COALESCE(sc.count, 0) AS "subscriberCount",
            s.recent_failure_details as "recentFailureDetails",
            s.websub_status as "websubStatus"
        FROM sources AS s
        LEFT JOIN subscriber_counts AS sc ON sc.source_id = s.id
        ORDER BY ${resolved.sort} ${resolved.order}
    `;

    const result: unknown = await this.drizzleConnection.execute(
      sql.raw(query),
    );
    return parseSourceListRows(result);
  }

  // Cascades via FK to articles and user_sources. Admin-level, distinct from
  // unsubscribing (UserSourcesDataService.removeSourceFromUser).
  public async deleteSource(id: number) {
    await this.drizzleConnection.delete(sources).where(eq(sources.id, id));
  }

  public async updateSourceUrl(
    oldUrl: string,
    newUrl: string,
  ): Promise<SourceUrlUpdateResult> {
    try {
      const updated = await this.drizzleConnection
        .update(sources)
        .set({ recentFailureDetails: "", recentFailures: 0, url: newUrl })
        .where(eq(sources.url, oldUrl))
        .returning({ id: sources.id });
      return updated.length > 0 ? "updated" : "not-found";
    } catch (error) {
      if (isUniqueViolation(error)) return "conflict";
      throw error;
    }
  }

  public async successSource(
    sourceId: number,
    cached = false,
    notBefore = new Date(Date.now() + pollFloorMs),
    // parseSource passes its own observedAt so this matches the
    // last_seen_in_feed_at written for the same fetch's articles exactly;
    // otherwise the two differ by this call's latency and cleanupOrphanedData
    // cannot tell "not in this fetch" from "just fetched".
    observedAt = new Date(),
    trigger: "email" | "manual" | "poll" | "websub-push" = "poll",
  ) {
    const clampedNotBefore = clampToPollFloor(notBefore, Date.now());
    await this.drizzleConnection
      .update(sources)
      .set({
        lastAttempt: observedAt,
        lastFetchTrigger: trigger,
        lastSuccess: observedAt,
        notBefore: clampedNotBefore,
        recentFailureDetails: cached ? "cached" : "not cached",
        recentFailures: 0,
      })
      .where(eq(sources.id, sourceId));
  }

  public async failSource(sourceId: number, reason = "") {
    try {
      // Stored on failure so the read side is just "notBefore <= NOW()".
      // recentFailures is incremented in the same expression this reads, so
      // +1 accounts for the failure being recorded now.
      await this.drizzleConnection
        .update(sources)
        .set({
          lastAttempt: new Date(),
          notBefore: sql`NOW() + INTERVAL '5 minutes' * LEAST(${sources.recentFailures} + 1, 15)`,
          recentFailureDetails: reason,
          recentFailures: sql`${sources.recentFailures} + 1`,
        })
        .where(eq(sources.id, sourceId));
    } catch (error) {
      console.error("fail source", error);
    }
  }

  public async updateFavicon(
    sourceId: number,
    favicon: Buffer,
    contentType: string,
  ) {
    await this.drizzleConnection
      .update(sources)
      .set({
        favicon: `data:${contentType};base64,${favicon.toString("base64")}`,
      })
      .where(eq(sources.id, sourceId));
  }

  public async getFavicon(sourceId: number) {
    const [row] = await this.drizzleConnection
      .select({ favicon: sources.favicon })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    return row?.favicon ?? null;
  }

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

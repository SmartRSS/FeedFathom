import { type Static, Type } from "typebox";
import Schema from "typebox/schema";
import { and, eq, getTableColumns, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { dateType } from "#shared/validation/typebox-policy.ts";
import { sourceSortSchema } from "../../contracts/requests.ts";
import { JobName } from "../../types/job-name-enum.ts";
import type * as schema from "../schema.ts";
import { type Source, sources } from "../schemas/sources.ts";
import { userSources } from "../schemas/user-sources.ts";

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

// Define a type for the select statement in listAllSources
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
const pollFloorMs = 5 * 60_000;
// Flat per-tick ceiling, replacing a "10% of whatever is due" throttle.
// That percentage self-balanced into a permanent backlog: at equilibrium
// each source waited ~3.3 extra minutes for a slot regardless of how many
// sources existed, stretching an intended 5-minute cadence to ~8.3 (the
// observed production median was 7.3). Draining what's due is well within
// capacity -- WORKER_REPLICAS * WORKER_CONCURRENCY is three orders of
// magnitude above a typical due count -- and notBefore already staggers
// arrivals, which is the smoothing the percentage was standing in for.
// The flat cap only bounds the pathological case (a long outage making
// every source due at once) instead of taxing the steady state.
const gatherBatchLimit = 500;
const exact = { additionalProperties: false } as const;
type SourceSort = Static<typeof sourceSortSchema>;
const sourceOrderSchema = Type.Union([
  Type.Literal("asc"),
  Type.Literal("desc"),
]);
const sourceSortCheck = Schema.Compile(sourceSortSchema);
const sourceOrderCheck = Schema.Compile(sourceOrderSchema);
const sourceSortSql = {
  createdAt: "s.created_at",
  lastAttempt: "s.last_attempt",
  lastSuccess: "s.last_success",
  recentFailures: "s.recent_failures",
  subscriberCount: '"subscriberCount"',
  url: "s.url",
} as const;
const sourceOrderSql = { asc: "ASC", desc: "DESC" } as const;
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
  const validSortBy = sourceSortCheck.Check(sortBy) ? sortBy : "createdAt";
  const validOrder = sourceOrderCheck.Check(order) ? order : "asc";
  return {
    order: sourceOrderSql[validOrder],
    sort: sourceSortSql[validSortBy],
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

  // subscriberCount rides along because the only caller is the ParseSource
  // job, which reports it to the origin in the User-Agent (see
  // buildUserAgent in http-client). A correlated subquery keeps this a
  // single round trip on the hot polling path rather than a second query
  // per fetch.
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

  // "email" sources are excluded outright -- there's no HTTP endpoint to
  // poll at all, unlike the old `url LIKE 'http%'` heuristic this replaced,
  // which inferred the same fact from the URL's shape instead of an
  // explicit column. "feed" sources are gated purely by notBefore now --
  // successSource/failSource write it directly (from Cache-Control, or the
  // backoff formula on failure) instead of this query recomputing a backoff
  // interval from recentFailures at read time. "websub" sources use a flat
  // once-daily last_attempt check regardless of recentFailures -- a hub
  // push is the primary update path, so this is purely a fallback safety
  // net for a dropped push, not the same kind of retry/backoff schedule
  // "feed" sources need, and deliberately ignores notBefore: a
  // Cache-Control-driven value from a normal fetch could otherwise schedule
  // a websub source's *next* check sooner than a day out, undermining the
  // point of the reduced cadence.
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

  // Cascades via FK (articles, user_sources, and everything beneath them)
  // -- an admin-level delete regardless of who's subscribed, distinct from
  // a user just unsubscribing (UserSourcesDataService.removeSourceFromUser).
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
    // Defaults to a fresh timestamp for callers that don't care, but
    // parseSource passes its own observedAt here so this stamp exactly
    // matches the last_seen_in_feed_at it just wrote for this fetch's
    // articles -- letting cleanupOrphanedData tell "not in this fetch"
    // apart from "just fetched a moment ago" instead of the two always
    // differing by whatever this function's own call latency happens to be.
    observedAt = new Date(),
    trigger: "email" | "manual" | "poll" | "websub-push" = "poll",
  ) {
    // A floor regardless of what the caller (or the origin's own
    // Cache-Control) asks for -- an origin sending no-cache/max-age=0
    // shouldn't be able to make a periodic poller hammer it every gather
    // cycle. Only matters for "feed" kind in practice (getSourcesToProcess
    // ignores notBefore for "websub"/"email"), but harmless to apply
    // unconditionally here since successSource doesn't know the kind.
    const clampedNotBefore = new Date(
      Math.max(notBefore.getTime(), Date.now() + pollFloorMs),
    );
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
      // Same backoff formula getSourcesToProcess used to recompute at read
      // time from recentFailures -- now stored directly on failure instead,
      // so the read side is just "notBefore <= NOW()". recentFailures is
      // incremented in the same expression this reads, so +1 accounts for
      // the failure being recorded right now.
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

  public async findOrCreateSourceByUrl(
    url: string,
    payload: { homeUrl: string; kind?: "email" | "feed" | undefined },
  ) {
    return await this.addSource({
      homeUrl: payload.homeUrl,
      kind: payload.kind,
      url,
    });
  }

  // Called after a poll discovers a hub advertisement and the source isn't
  // already tracking that exact hub/topic pair. Generates a fresh per-
  // subscription secret and callback token and moves straight to "pending"
  // -- the actual hub POST happens in the caller right after this, using
  // the returned values, so this and the subscribe attempt always agree on
  // which secret/token are current.
  // Atomic claim guarding against concurrent subscribe attempts for the
  // same source (see the schema comment on websubSubscribeAttemptedAt) --
  // returns false if another attempt already claimed this source within
  // the cooldown window, so the caller should skip subscribing rather than
  // race a second request to the hub with a different callback token.
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
        // kind: "websub" is what actually drives the reduced polling
        // cadence (see getSourcesToProcess) -- WebSub delivery isn't
        // guaranteed, so this isn't "stop polling entirely," just a much
        // longer fallback interval than "feed" kind gets.
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
        // Revert to ordinary polling cadence -- staying "websub" kind
        // with a dead subscription would leave this source checked only
        // once a day with no push arriving to make up for it.
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

  // Subscriptions within a day of expiring -- the renewal job runs daily
  // (see MainWorker), so this window guarantees every verified subscription
  // gets at least one renewal attempt before its lease actually lapses,
  // even if a given day's job run is late or fails outright.
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

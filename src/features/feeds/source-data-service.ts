import type { Static } from "typebox";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { sourceSortSchema } from "#shared/contracts/requests.ts";
import type * as schema from "#platform/db/schema.ts";
import { type Source, sources } from "#platform/db/schemas/sources.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import {
  clampToPollFloor,
  pollFloorMs,
} from "#features/feeds/source-schedule-policy.ts";

// Bound each gathering pass when an outage makes many sources due at once.
// notBefore staggers normal arrivals; the cap does not scale with backlog size.
const gatherBatchLimit = 500;
// A correlated subquery keeps each caller to one round trip. The outer id is
// qualified by hand: drizzle drops the table name from columns in a
// single-table select, and a bare "id" here would mean user_sources.id.
const subscriberCount = sql<number>`(
  SELECT COUNT(*)::int
  FROM ${userSources}
  WHERE ${userSources.sourceId} = ${sources}.${sql.identifier(sources.id.name)}
)`;
const sourceSortColumns = {
  createdAt: sources.createdAt,
  lastAttempt: sources.lastAttempt,
  lastSuccess: sources.lastSuccess,
  recentFailures: sources.recentFailures,
  subscriberCount,
  url: sources.url,
} satisfies Record<Static<typeof sourceSortSchema>, unknown>;

const isUniqueViolation = (error: unknown, depth = 0): boolean => {
  if (typeof error !== "object" || error === null || depth > 3) return false;
  const code = "code" in error ? error.code : undefined;
  const errno = "errno" in error ? error.errno : undefined;
  if (code === "23505" || errno === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause, depth + 1);
};

export type SourceUrlUpdateResult = "conflict" | "not-found" | "updated";

/**
 * Sources repository: CRUD on the sources table plus the poll-schedule
 * bookkeeping (lastAttempt/lastSuccess/notBefore/recentFailures) written by
 * the fetch pipeline. WebSub lease state lives in WebSubStateService, favicon
 * storage in FaviconStore, and ParseSource enqueueing in SourceEnqueuer.
 */
export class SourcesDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
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

  // subscriberCount rides along for the ParseSource job's User-Agent (see
  // buildUserAgent).
  public async findSourceById(
    sourceId: number,
  ): Promise<(Source & { subscriberCount: number }) | undefined> {
    return (
      await this.drizzleConnection
        .select({ ...getTableColumns(sources), subscriberCount })
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
    return await this.drizzleConnection
      .select({ id: sources.id, url: sources.url })
      .from(sources)
      .where(
        or(
          and(eq(sources.kind, "feed"), lte(sources.notBefore, sql`NOW()`)),
          and(
            eq(sources.kind, "websub"),
            or(
              isNull(sources.lastAttempt),
              lt(sources.lastAttempt, sql`NOW() - INTERVAL '1 day'`),
            ),
          ),
        ),
      )
      .orderBy(sql`${sources.lastAttempt} ASC NULLS FIRST`)
      .limit(gatherBatchLimit);
  }

  public async listAllSources(
    sortBy: Static<typeof sourceSortSchema>,
    order: "asc" | "desc",
  ) {
    return await this.drizzleConnection
      .select({
        createdAt: sources.createdAt,
        homeUrl: sources.homeUrl,
        id: sources.id,
        lastAttempt: sources.lastAttempt,
        lastFetchTrigger: sources.lastFetchTrigger,
        lastSuccess: sources.lastSuccess,
        recentFailureDetails: sources.recentFailureDetails,
        recentFailures: sources.recentFailures,
        subscriberCount,
        url: sources.url,
        websubStatus: sources.websubStatus,
      })
      .from(sources)
      // id breaks the tie: every column the admin table can sort by holds
      // duplicates (recent_failures is 0 for almost every row), and without
      // a unique last key the tied rows reshuffle between two loads of the
      // same sort, which reads as the table changing on its own.
      .orderBy(
        (order === "desc" ? desc : asc)(sourceSortColumns[sortBy]),
        asc(sources.id),
      );
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
}

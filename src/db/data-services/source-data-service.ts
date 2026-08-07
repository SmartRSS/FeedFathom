import { type Static, Type } from "typebox";
import Schema from "typebox/schema";
import { eq, gt, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { sourceSortSchema } from "../../contracts/requests.ts";
import { dateType } from "../../lib/typebox-policy.ts";
import { JobName } from "../../types/job-name-enum.ts";
import type * as schema from "../schema.ts";
import { type Source, sources } from "../schemas/sources.ts";

type SourceQueue = {
  add(
    name: JobName,
    data: { id: number; skipCache: boolean; url: string },
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
  lastSuccess: Date | null;
  recentFailures: number;
  subscriberCount: number;
  recentFailureDetails: string;
}

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
      lastSuccess: Type.Union([dateType, Type.Null()]),
      recentFailureDetails: Type.String(),
      recentFailures: Type.Integer(),
      subscriberCount: Type.Integer({ minimum: 0 }),
      url: Type.String(),
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

  public async enqueueSource(source: { id: number; url: string }) {
    await this.bullmqQueue.add(
      JobName.ParseSource,
      { id: source.id, skipCache: true, url: source.url },
      {
        jobId: `${JobName.ParseSource}-${source.id}`,
        lifo: true,
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    );
  }

  public async findSourceById(sourceId: number): Promise<Source | undefined> {
    return (
      await this.drizzleConnection
        .select()
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

  public async getSourcesToProcess() {
    const result: unknown = await this.drizzleConnection.execute(sql`
      WITH "due_sources" AS (
        SELECT ${sources.id} AS "id", ${sources.url} AS "url", ${sources.lastAttempt} AS "last_attempt"
        FROM ${sources}
        WHERE (${sources.nextCheckAt} IS NULL OR ${sources.nextCheckAt} <= NOW())
          AND (
            ${sources.lastAttempt} IS NULL
            OR (
              ${sources.recentFailures} = 0
              AND ${sources.lastAttempt} < NOW() - INTERVAL '5 minutes'
            )
            OR (
              ${sources.recentFailures} > 0
              AND ${sources.lastAttempt} < NOW() - INTERVAL '5 minutes' * LEAST(${sources.recentFailures}, 15)
            )
          )
          AND ${sources.url} LIKE 'http%'
      )
      SELECT "id", "url"
      FROM "due_sources"
      ORDER BY "last_attempt" ASC NULLS FIRST
      LIMIT GREATEST(
        1,
        (SELECT CEIL(COUNT(*) * 0.1)::int FROM "due_sources")
      )
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
            s.last_success as "lastSuccess",
            COALESCE(s.recent_failures, 0) as "recentFailures",
            COALESCE(sc.count, 0) AS "subscriberCount",
            s.recent_failure_details as "recentFailureDetails"
        FROM sources AS s
        LEFT JOIN subscriber_counts AS sc ON sc.source_id = s.id
        ORDER BY ${resolved.sort} ${resolved.order}
    `;

    const result: unknown = await this.drizzleConnection.execute(
      sql.raw(query),
    );
    return parseSourceListRows(result);
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
    nextCheckAt = new Date(Date.now() + 5 * 60_000),
    // Defaults to a fresh timestamp for callers that don't care, but
    // parseSource passes its own observedAt here so this stamp exactly
    // matches the last_seen_in_feed_at it just wrote for this fetch's
    // articles -- letting cleanupOrphanedData tell "not in this fetch"
    // apart from "just fetched a moment ago" instead of the two always
    // differing by whatever this function's own call latency happens to be.
    observedAt = new Date(),
  ) {
    await this.drizzleConnection
      .update(sources)
      .set({
        lastAttempt: observedAt,
        lastSuccess: observedAt,
        nextCheckAt,
        recentFailureDetails: cached ? "cached" : "not cached",
        recentFailures: 0,
      })
      .where(eq(sources.id, sourceId));
  }

  public async failSource(sourceId: number, reason = "") {
    try {
      await this.drizzleConnection
        .update(sources)
        .set({
          lastAttempt: new Date(),
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
    payload: { homeUrl: string },
  ) {
    return await this.addSource({
      homeUrl: payload.homeUrl,
      url,
    });
  }
}

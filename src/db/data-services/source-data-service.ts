import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { PostgresQueue } from "$lib/postgres-queue";
import { JobName } from "../../types/job-name-enum.ts";
import { logError } from "../../util/log.ts";
import { type Source, sources } from "../schemas/sources.ts";

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

export class SourcesDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase,
    private readonly postgresQueue: PostgresQueue,
  ) {}

  public async addSource(payload: { homeUrl: string; url: string }) {
    const source = (
      await this.drizzleConnection.insert(sources).values(payload).returning()
    ).at(0);
    if (!source) {
      throw new Error("failed");
    }

    await this.postgresQueue.addJobToQueue({
      generalId: `${JobName.ParseSource}:${source.id}`,
      name: JobName.ParseSource,
      payload: {
        id: source.id,
        skipCache: true,
        url: source.url,
      },
    });
    return source;
  }

  public async findSourceById(sourceId: number) {
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
    const noRecentFailures = () => {
      return eq(sources.recentFailures, 0);
    };

    const failedRecently = () => {
      return gt(sources.recentFailures, 0);
    };

    const failedAttemptTimeout = () => {
      return sql`${sources.lastAttempt} < NOW() - INTERVAL '5 minutes' * LEAST(${sources.recentFailures}, 15)`;
    };

    const lastAttemptTimeout = () => {
      return lt(sources.lastAttempt, sql`NOW() - INTERVAL '5 minutes'`);
    };

    const isLastAttemptNull = () => {
      return isNull(sources.lastAttempt);
    };

    const isWebSource = () => {
      return sql`${sources.url} LIKE 'http%'`;
    };

    const shouldProcessSource = () => {
      return or(
        or(
          and(noRecentFailures(), lastAttemptTimeout()),
          and(failedRecently(), failedAttemptTimeout()),
        ),
        isLastAttemptNull(),
      );
    };

    return await this.drizzleConnection
      .select({
        id: sources.id,
        url: sources.url,
      })
      .from(sources)
      .where(and(shouldProcessSource(), isWebSource()))
      .orderBy(asc(sources.lastAttempt))
      .limit(
        sql`(SELECT CEIL(COUNT(*) * 0.1)::int FROM ${sources})::int;` as unknown as number,
      );
  }

  public async listAllSources(
    sortBy: string,
    order: "asc" | "desc",
  ): Promise<SourceWithSubscriberCount[]> {
    // Validate sortBy and order to prevent SQL injection, TS can't enforce runtime safety without this
    const validSortBy = [
      "created_at",
      "failures",
      "last_attempt",
      "last_success",
      "subscriber_count",
      "url",
    ].includes(sortBy)
      ? sortBy
      : "created_at";
    const validOrder = ["asc", "desc"].includes(order) ? order : "asc";

    const query = `
        WITH subscriber_counts AS (
            SELECT
                us.source_id,
                COUNT(us.user_id) AS count
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
        ORDER BY "${validSortBy}" ${validOrder}
    `;

    const result = await this.drizzleConnection.execute(sql.raw(query));

    return result as unknown as SourceWithSubscriberCount[];
  }

  public async updateSourceUrl(oldUrl: string, newUrl: string) {
    await this.drizzleConnection
      .update(sources)
      .set({ recentFailureDetails: "", recentFailures: 0, url: newUrl })
      .where(eq(sources.url, oldUrl));
  }

  public async successSource(sourceId: number, cached = false) {
    const now = new Date();
    await this.drizzleConnection
      .update(sources)
      .set({
        lastAttempt: now,
        lastSuccess: now,
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
      logError("fail source", error);
    }
  }

  public async updateFavicon(sourceId: number, favicon: Buffer | string) {
    let type: string;
    let encoded: string;

    if (Buffer.isBuffer(favicon)) {
      type = "png";
      encoded = favicon.toString("base64");
    } else {
      type = "svg+xml";
      encoded = Buffer.from(favicon, "utf8").toString("base64");
    }

    await this.drizzleConnection
      .update(sources)
      .set({
        favicon: `data:image/${type};base64,${encoded}`,
      })
      .where(eq(sources.id, sourceId));
  }

  public async findOrCreateSourceByUrl(
    url: string,
    payload: { homeUrl: string },
  ) {
    const source = await this.findSourceByUrl(url);
    if (source) {
      return source;
    }

    return await this.addSource({
      homeUrl: payload.homeUrl,
      url,
    });
  }
}

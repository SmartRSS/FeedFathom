import { JobName } from "../../types/job-name.enum";
import { err as error } from "../../util/log";
import * as schema from "../schema";
import { type Queue } from "bullmq";
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { type BunSQLDatabase } from "drizzle-orm/bun-sql";

type SortField =
  | "created_at"
  | "failures"
  | "last_attempt"
  | "last_success"
  | "subscriber_count"
  | "url";

export class SourcesRepository {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase,
    private readonly bullmqQueue: Queue,
  ) {}

  public async addSource(payload: { homeUrl: string; url: string; }) {
    const source = (
      await this.drizzleConnection
        .insert(schema.sources)
        .values(payload)
        .returning()
    ).at(0);
    if (!source) {
      throw new Error("failed");
    }

    await this.bullmqQueue.add(JobName.PARSE_SOURCE, {
      id: source.id,
      skipCache: true,
      url: source.url,
    });
    return source;
  }

  public async failSource(
    sourceId: number,
    reason: string = "",
  ): Promise<void> {
    try {
      await this.drizzleConnection
        .update(schema.sources)
        .set({
          lastAttempt: new Date(),
          recentFailureDetails: reason,
          recentFailures: sql`${schema.sources.recentFailures} + 1`,
        })
        .where(eq(schema.sources.id, sourceId));
    } catch (error_) {
      error("fail source", error_);
    }
  }

  public async findOrCreateSourceByUrl(
    url: string,
    payload: {
      home_url: string;
    },
  ) {
    const source = await this.findSourceByUrl(url);
    if (source) {
      return source;
    }

    return await this.addSource({
      homeUrl: payload.home_url,
      url,
    });
  }

  public async findSourceByUrl(url: string) {
    return (
      await this.drizzleConnection
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.url, url))
    ).at(0);
  }

  public async getRecentlySuccessfulSources() {
    return this.drizzleConnection
      .select({
        homeUrl: schema.sources.homeUrl,
        id: schema.sources.id,
      })
      .from(schema.sources)
      .where(gt(schema.sources.lastSuccess, sql`NOW() - INTERVAL '5 minutes'`));
  }

  public async getSourcesToProcess() {
    const noRecentFailures = () => {return eq(schema.sources.recentFailures, 0)};
    const failedRecently = () => {return gt(schema.sources.recentFailures, 0)};

    const failedAttemptTimeout = () =>
      {return sql`${schema.sources.lastAttempt} < NOW() - INTERVAL '5 minutes' * LEAST(${schema.sources.recentFailures}, 15)`};

    const lastAttemptTimeout = () =>
      {return lt(schema.sources.lastAttempt, sql`NOW() - INTERVAL '5 minutes'`)};

    const isLastAttemptNull = () => {return isNull(schema.sources.lastAttempt)};

    const isWebSource = () => {return sql`${schema.sources.url} LIKE 'http%'`};

    const shouldProcessSource = () =>
      {return or(
        or(
          and(noRecentFailures(), lastAttemptTimeout()),
          and(failedRecently(), failedAttemptTimeout()),
        ),
        isLastAttemptNull(),
      )};

    return this.drizzleConnection
      .select({
        id: schema.sources.id,
        url: schema.sources.url,
      })
      .from(schema.sources)
      .where(and(shouldProcessSource(), isWebSource()))
      .orderBy(asc(schema.sources.lastAttempt))
      .limit(
        sql`(SELECT CEIL(COUNT(*) * 0.1)::int FROM ${schema.sources})::int;` as unknown as number,
      );
  }

  public async listAllSources(sortBy: SortField, order: "asc" | "desc") {
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
            s.home_url,
            s.created_at,
            s.last_attempt,
            s.last_success,
            COALESCE(s.recent_failures, 0) as failures,
            COALESCE(sc.count, 0) AS subscriber_count,
            s.recent_failure_details
        FROM sources AS s
        LEFT JOIN subscriber_counts AS sc ON sc.source_id = s.id
        ORDER BY ${validSortBy} ${validOrder}
    `;

    return this.drizzleConnection.execute(query);
  }

  public async successSource(
    sourceId: number,
    cached: boolean = false,
  ): Promise<void> {
    const now = new Date();
    await this.drizzleConnection
      .update(schema.sources)
      .set({
        lastAttempt: now,
        lastSuccess: now,
        recentFailureDetails: cached ? "cached" : "not cached",
        recentFailures: 0,
      })
      .where(eq(schema.sources.id, sourceId));
  }

  public async updateFavicon(
    sourceId: number,
    favicon: Buffer | string,
  ): Promise<void> {
    let type: string;
    let encoded: string;

    if (Buffer.isBuffer(favicon)) {
      type = "png";
      encoded = favicon.toString("base64");
    } else {
      type = "svg+xml";
      encoded = Buffer.from(favicon, "utf-8").toString("base64");
    }

    await this.drizzleConnection
      .update(schema.sources)
      .set({
        favicon: `data:image/${type};base64,${encoded}`,
      })
      .where(eq(schema.sources.id, sourceId));
  }

  public async updateSourceUrl(oldUrl: string, newUrl: string): Promise<void> {
    await this.drizzleConnection
      .update(schema.sources)
      .set({ recentFailureDetails: "", recentFailures: 0, url: newUrl })
      .where(eq(schema.sources.url, oldUrl));
  }
}

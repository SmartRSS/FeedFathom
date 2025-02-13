import * as schema from "../schema";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { err } from "../../util/log";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { Queue } from "bullmq";
import { JobName } from "../../types/job-name.enum";

type SortField =
  | "url"
  | "subscriber_count"
  | "created_at"
  | "last_attempt"
  | "last_success"
  | "failures";

export class SourcesRepository {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase,
    private readonly bullmqQueue: Queue,
  ) {}

  public async updateFavicon(sourceId: number, favicon: Buffer): Promise<void> {
    await this.drizzleConnection
      .update(schema.sources)
      .set({ favicon: favicon.toString("base64") })
      .where(eq(schema.sources.id, sourceId));
  }

  public async getSourcesToProcess() {
    const noRecentFailures = () => eq(schema.sources.recentFailures, 0);

    const failedAttemptTimeout = () =>
      sql`${schema.sources.lastAttempt} < NOW() - INTERVAL '5 minutes' * LEAST(${schema.sources.recentFailures}, 15)`;

    const lastAttemptTimeout = () =>
      lt(
        schema.sources.lastAttempt,
        sql`NOW() - (INTERVAL '1 minute' * RANDOM() * 25) + INTERVAL '7 minutes'`,
      );

    const isLastAttemptNull = () => isNull(schema.sources.lastAttempt);

    const isWebSource = () => sql`${schema.sources.url} LIKE 'http%'`;

    return this.drizzleConnection
      .select({
        id: schema.sources.id,
        url: schema.sources.url,
      })
      .from(schema.sources)
      .where(
        and(
          or(
            or(
              and(noRecentFailures(), lastAttemptTimeout()),
              failedAttemptTimeout(),
            ),
            isLastAttemptNull(),
          ),
          isWebSource(),
        ),
      );
  }

  public async findSourceByUrl(url: string) {
    return (
      await this.drizzleConnection
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.url, url))
    ).at(0);
  }

  public async addSource(payload: { url: string; homeUrl: string }) {
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
      url: source.url,
      skipCache: true,
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
          recentFailures: sql`${schema.sources.recentFailures} + 1`,
          recentFailureDetails: reason,
        })
        .where(eq(schema.sources.id, sourceId));
    } catch (e) {
      err("fail source", e);
    }
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
        recentFailures: 0,
        recentFailureDetails: cached ? "cached" : "not cached",
      })
      .where(eq(schema.sources.id, sourceId));
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
      url: url,
      homeUrl: payload.home_url,
    });
  }

  public async listAllSources(sortBy: SortField, order: "asc" | "desc") {
    // Validate sortBy and order to prevent SQL injection, TS can't enforce runtime safety without this
    const validSortBy = [
      "subscriber_count",
      "created_at",
      "last_attempt",
      "last_success",
      "url",
      "failures",
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

  public async getRecentlySuccessfulSources() {
    return this.drizzleConnection
      .select({
        id: schema.sources.id,
        homeUrl: schema.sources.homeUrl,
      })
      .from(schema.sources)
      .where(gt(schema.sources.lastSuccess, new Date()));
  }

  public async updateSourceUrl(oldUrl: string, newUrl: string): Promise<void> {
    await this.drizzleConnection
      .update(schema.sources)
      .set({ url: newUrl, recentFailures: 0, recentFailureDetails: "" })
      .where(eq(schema.sources.url, oldUrl));
  }
}

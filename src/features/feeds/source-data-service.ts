import type { Static } from "typebox";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { sourceSortSchema } from "#shared/contracts/requests.ts";
import type * as schema from "#platform/db/schema.ts";
import {
  type FetchTrigger,
  type Source,
  sources,
} from "#platform/db/schemas/sources.ts";
import { articles } from "#platform/db/schemas/articles.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import {
  hasSubscriber,
  inSubscriberlessGrace,
} from "#features/feeds/retention.ts";
import {
  clampToPollFloor,
  failureBackoffMaxSteps,
  pollFloorMs,
  webSubFallbackPollMs,
} from "#features/feeds/source-schedule-policy.ts";
import { faviconGatherWindowMs } from "#features/feeds/favicon-refresher.ts";

const gatherBatchLimit = 500;
const sourceSortColumns = {
  createdAt: sources.createdAt,
  lastAttempt: sources.lastAttempt,
  lastSuccess: sources.lastSuccess,
  recentFailures: sources.recentFailures,
  url: sources.url,
} satisfies Record<
  Exclude<Static<typeof sourceSortSchema>, "subscriberCount">,
  unknown
>;

export const hasSqlState = (
  error: unknown,
  state: "23503" | "23505",
  depth = 0,
): boolean => {
  if (typeof error !== "object" || error === null || depth > 3) return false;
  const code = "code" in error ? error.code : undefined;
  const errno = "errno" in error ? error.errno : undefined;
  if (code === state || errno === state) return true;
  return "cause" in error && hasSqlState(error.cause, state, depth + 1);
};

type SourceUrlUpdateResult = "conflict" | "not-found" | "updated";

export class SourcesDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

  public async addSource(
    {
      homeUrl,
      kind,
      reservedBy,
      url,
    }:
      | { homeUrl: string; kind: "email"; reservedBy?: number; url: string }
      | {
          homeUrl?: string | undefined;
          kind?: "feed" | undefined;
          reservedBy?: undefined;
          url: string;
        },
    db: Pick<
      BunSQLDatabase<typeof schema>,
      "insert" | "select"
    > = this.drizzleConnection,
  ): Promise<Source> {
    const inserted = (
      await db
        .insert(sources)
        .values({
          homeUrl: homeUrl ?? new URL(url).origin,
          kind,
          reservedBy,
          url,
        })
        .onConflictDoNothing({ target: sources.url })
        .returning()
    ).at(0);
    if (inserted) return inserted;

    const existing = (
      await db.select().from(sources).where(eq(sources.url, url))
    ).at(0);
    if (!existing) throw new Error("Source conflict resolved without a row");
    return existing;
  }

  public async findSourceById(
    sourceId: number,
  ): Promise<(Source & { subscriberCount: number }) | undefined> {
    const { favicon: _favicon, ...columnsWithoutFavicon } =
      getTableColumns(sources);
    return (
      await this.drizzleConnection
        .select({
          ...columnsWithoutFavicon,
          subscriberCount: this.drizzleConnection.$count(
            userSources,
            eq(userSources.sourceId, sources.id),
          ),
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

  public async findMailRecipient(url: string): Promise<Source | undefined> {
    return (
      await this.drizzleConnection
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.url, url),
            or(inSubscriberlessGrace, hasSubscriber(this.drizzleConnection)),
          ),
        )
    ).at(0);
  }

  public async getSourcesDueFaviconRefresh() {
    return await this.drizzleConnection
      .select({
        hasFavicon: isNotNull(sources.faviconHash).mapWith(Boolean),
        homeUrl: sources.homeUrl,
        id: sources.id,
      })
      .from(sources)
      .where(
        and(
          gt(
            sources.lastSuccess,
            sql`NOW() - ${faviconGatherWindowMs} * INTERVAL '1 millisecond'`,
          ),
          ne(sources.kind, "email"),
        ),
      )
      .orderBy(isNotNull(sources.faviconHash), asc(sources.id));
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

  public async getSourcesToProcess() {
    return await this.drizzleConnection
      .select({ id: sources.id })
      .from(sources)
      .where(
        or(
          and(eq(sources.kind, "feed"), lte(sources.notBefore, sql`NOW()`)),
          and(
            eq(sources.kind, "websub"),
            or(
              isNull(sources.lastAttempt),
              lt(
                sources.lastAttempt,
                sql`NOW() - ${webSubFallbackPollMs} * INTERVAL '1 millisecond'`,
              ),
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
    const subscriberCounts = this.drizzleConnection
      .select({
        count: sql<number>`COUNT(*)::int`.as("count"),
        sourceId: userSources.sourceId,
      })
      .from(userSources)
      .groupBy(userSources.sourceId)
      .as("subscriber_counts");
    const joinedSubscriberCount = sql<number>`COALESCE(${subscriberCounts.count}, 0)`;
    const sortColumn =
      sortBy === "subscriberCount"
        ? joinedSubscriberCount
        : sourceSortColumns[sortBy];
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
        subscriberCount: joinedSubscriberCount,
        url: sources.url,
        websubStatus: sources.websubStatus,
      })
      .from(sources)
      .leftJoin(subscriberCounts, eq(subscriberCounts.sourceId, sources.id))
      .orderBy((order === "desc" ? desc : asc)(sortColumn), asc(sources.id));
  }

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
      if (hasSqlState(error, "23505")) return "conflict";
      throw error;
    }
  }

  public async canSkipUnchangedBody(
    sourceId: number,
    throttleHours: number,
  ): Promise<boolean> {
    const [row] = await this.drizzleConnection
      .select({
        canSkip: sql<boolean>`
          MAX(${articles.lastSeenInFeedAt}) IS NOT NULL
          AND MAX(${articles.lastSeenInFeedAt}) >= GREATEST(
            NOW() - ${throttleHours} * INTERVAL '1 hour',
            COALESCE(
              (SELECT MAX(${userSources.createdAt}) FROM ${userSources} WHERE ${userSources.sourceId} = ${sourceId}),
              '-infinity'::timestamptz
            )
          )
        `,
      })
      .from(articles)
      .where(eq(articles.sourceId, sourceId));
    return row?.canSkip === true;
  }

  public async successSource(
    sourceId: number,
    {
      bodyHash,
      cached,
      homeUrl,
      notBefore,
      trigger,
    }: {
      bodyHash?: null | string | undefined;
      cached: boolean;
      homeUrl?: string | undefined;
      notBefore?: Date | undefined;
      trigger: FetchTrigger;
    },
  ) {
    await this.drizzleConnection
      .update(sources)
      .set({
        ...(bodyHash === undefined ? {} : { lastBodyHash: bodyHash }),
        ...(homeUrl === undefined ? {} : { homeUrl }),
        lastAttempt: sql`NOW()`,
        lastFetchTrigger: trigger,
        lastSuccess: sql`NOW()`,
        notBefore: clampToPollFloor(notBefore, Date.now()),
        recentFailureDetails: cached ? "cached" : "not cached",
        recentFailures: 0,
      })
      .where(eq(sources.id, sourceId));
  }

  public async failSource(sourceId: number, reason = "") {
    await this.drizzleConnection
      .update(sources)
      .set({
        lastAttempt: new Date(),
        notBefore: sql`NOW() + ${pollFloorMs} * INTERVAL '1 millisecond' * LEAST(${sources.recentFailures} + 1, ${failureBackoffMaxSteps})`,
        recentFailureDetails: reason,
        recentFailures: sql`${sources.recentFailures} + 1`,
      })
      .where(eq(sources.id, sourceId));
  }
}

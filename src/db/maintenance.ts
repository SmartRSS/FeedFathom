import { and, eq, exists, inArray, notExists, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "./schema.ts";
import { articles } from "./schemas/articles";
import { sources } from "./schemas/sources";
import { userSources } from "./schemas/userSources";

export async function cleanupOrphanedData(
  drizzleConnection: BunSQLDatabase<typeof schema>,
) {
  // "Delete sources nobody subscribes to" is, by construction, "delete
  // every source" whenever user_sources is empty -- true whether that's
  // expressed as NOT IN or as a correlated NOT EXISTS per source row.
  // If nobody has ever subscribed to anything (last subscription just
  // removed) deleting every source is correct; if user_sources is
  // empty for any other, transient reason, it isn't. Since this method
  // can't tell those apart, guard with an uncorrelated existence check
  // on the whole table, in the same statement so there's no separate
  // check-then-delete round trip to race against.
  await drizzleConnection
    .delete(sources)
    .where(
      and(
        exists(
          drizzleConnection.select({ id: userSources.id }).from(userSources),
        ),
        notExists(
          drizzleConnection
            .select({ id: userSources.id })
            .from(userSources)
            .where(eq(userSources.sourceId, sources.id)),
        ),
      ),
    );

  const articlesBeforeSubscription = drizzleConnection
    .select({ id: articles.id })
    .from(articles)
    .leftJoin(
      drizzleConnection
        .select({
          sourceId: userSources.sourceId,
          earliestSubscription: sql<Date>`min(${userSources.createdAt})`.as(
            "earliest_subscription",
          ),
        })
        .from(userSources)
        .groupBy(userSources.sourceId)
        .as("earliest_subs"),
      eq(articles.sourceId, sql`earliest_subs.source_id`),
    )
    .where(
      and(
        sql`earliest_subs.source_id IS NOT NULL`,
        sql`${articles.lastSeenInFeedAt} < earliest_subs.earliest_subscription`,
      ),
    );

  await drizzleConnection
    .delete(articles)
    .where(inArray(articles.id, articlesBeforeSubscription));
}

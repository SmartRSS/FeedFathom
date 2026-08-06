import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "./schema.ts";
import { articles } from "./schemas/articles";
import { sources } from "./schemas/sources";
import { userArticles } from "./schemas/userArticles";
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

  // The above only prunes articles no CURRENT subscriber could ever have
  // seen. This catches the complement: articles current subscribers COULD
  // see, but which are gone for good -- confirmed absent from the most
  // recent successful fetch of their source (last_seen_in_feed_at predates
  // sources.last_success, so a real re-fetch, not just a failed attempt,
  // didn't find it), and every subscriber who could have seen it has
  // already deleted it. "Could have seen it" is scoped to subscribers who
  // joined before it disappeared -- someone who subscribed later never had
  // the chance to see or delete it, so their absence of a deletion row
  // doesn't block the prune.
  const articlesUnreachableByAnyone = drizzleConnection
    .select({ id: articles.id })
    .from(articles)
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(
      and(
        isNotNull(sources.lastSuccess),
        sql`${articles.lastSeenInFeedAt} < ${sources.lastSuccess}`,
        notExists(
          drizzleConnection
            .select({ id: userSources.id })
            .from(userSources)
            .where(
              and(
                eq(userSources.sourceId, articles.sourceId),
                lte(userSources.createdAt, articles.lastSeenInFeedAt),
                notExists(
                  drizzleConnection
                    .select({ userId: userArticles.userId })
                    .from(userArticles)
                    .where(
                      and(
                        eq(userArticles.userId, userSources.userId),
                        eq(userArticles.articleId, articles.id),
                        isNotNull(userArticles.deletedAt),
                      ),
                    ),
                ),
              ),
            ),
        ),
      ),
    );

  await drizzleConnection
    .delete(articles)
    .where(inArray(articles.id, articlesUnreachableByAnyone));
}

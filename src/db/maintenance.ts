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
import { users } from "./schemas/users";

// A source's last_success is stamped strictly after its articles' upsert
// (see FeedParser.parseSource), so last_seen_in_feed_at < last_success is
// true for EVERY article on EVERY successful fetch -- including ones that
// were just confirmed present -- by construction, not just for ones that
// are actually missing. This buffer must be far larger than any real gap
// between a fetch's upsert and its own success stamp (milliseconds) so the
// comparison only fires once an article has survived many real fetch
// cycles without appearing (successSource's poll floor is 5 minutes).
const confirmedGoneFromFeedBuffer = sql`INTERVAL '1 day'`;

const daysInterval = (days: number) => sql`(${days} * INTERVAL '1 day')`;

export async function cleanupOrphanedData(
  drizzleConnection: BunSQLDatabase<typeof schema>,
  userDormantAfterDays: number,
  articleStaleAfterDays: number,
  userExpiryDays: number,
) {
  // Account expiry runs first: it shrinks the "current subscriber" set
  // (via cascade on user_sources) before every rule below evaluates it, so
  // an expired user's own subscriptions never need special-casing further
  // down -- they're simply gone, the same as if they'd never subscribed.
  if (userExpiryDays > 0) {
    await drizzleConnection
      .delete(users)
      .where(
        sql`${users.lastSeenAt} < NOW() - ${daysInterval(userExpiryDays)}`,
      );
  }

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
  // see, but which are gone for good -- confirmed absent across many
  // consecutive successful fetches of their source (see
  // confirmedGoneFromFeedBuffer above), and every subscriber who could
  // have seen it has already deleted it. "Could have seen it" is scoped to
  // subscribers who joined before it disappeared -- someone who
  // subscribed later never had the chance to see or delete it, so their
  // absence of a deletion row doesn't block the prune.
  const articlesUnreachableByAnyone = drizzleConnection
    .select({ id: articles.id })
    .from(articles)
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(
      and(
        isNotNull(sources.lastSuccess),
        sql`${articles.lastSeenInFeedAt} < ${sources.lastSuccess} - ${confirmedGoneFromFeedBuffer}`,
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

  // Neither rule above accounts for dormancy: a subscriber who hasn't made
  // a request in a long time still counts as a full "current subscriber"
  // for both. This catches articles old enough (articleStaleAfterDays)
  // that no subscriber who could have seen them is still active --
  // independent of whether anyone deleted them, since a dormant
  // subscriber's undeleted article isn't evidence anyone still wants it.
  // Either threshold at 0 turns this rule off entirely: 0 always means
  // "disabled", never "no requirement" (a 0-day staleness floor would
  // defeat the reason that guard exists in the first place).
  if (userDormantAfterDays > 0 && articleStaleAfterDays > 0) {
    const articlesOnlyDormantCouldSee = drizzleConnection
      .select({ id: articles.id })
      .from(articles)
      .where(
        and(
          sql`${articles.lastSeenInFeedAt} < NOW() - ${daysInterval(articleStaleAfterDays)}`,
          notExists(
            drizzleConnection
              .select({ id: userSources.id })
              .from(userSources)
              .innerJoin(users, eq(users.id, userSources.userId))
              .where(
                and(
                  eq(userSources.sourceId, articles.sourceId),
                  lte(userSources.createdAt, articles.lastSeenInFeedAt),
                  sql`${users.lastSeenAt} > NOW() - ${daysInterval(userDormantAfterDays)}`,
                ),
              ),
          ),
        ),
      );

    await drizzleConnection
      .delete(articles)
      .where(inArray(articles.id, articlesOnlyDormantCouldSee));
  }
}

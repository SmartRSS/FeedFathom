import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  min,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { articles } from "#platform/db/schemas/articles.ts";
import { sessions } from "#platform/db/schemas/sessions.ts";
import { sources } from "#platform/db/schemas/sources.ts";
import { userArticles } from "#platform/db/schemas/user-articles.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import { users } from "#platform/db/schemas/users.ts";

// How long an article must go unseen before the feed counts as having dropped
// it. One fetch omitting an item means nothing -- pagination, reordering and
// truncation all do that -- so the buffer must span many of the source's own
// cycles. A flat interval can't: a feed advertising a long max-age parks days
// out and websub only polls daily, so one flat day is less than one cycle.
// That false positive once destroyed 89k articles' deletion records.
//
// Scaled by cadence instead: not_before - last_success is the refresh interval
// the origin asked for (both written by the same successSource UPDATE), and
// websub ignores that column, so it gets the flat daily fallback. Every
// degenerate case lands on a LARGER buffer, erring towards keeping.
const confirmedGoneFromFeedBuffer = sql`
  GREATEST(
    INTERVAL '1 day',
    10 * CASE ${sources.kind}
      WHEN 'websub' THEN INTERVAL '1 day'
      ELSE ${sources.notBefore} - ${sources.lastSuccess}
    END
  )
`;

// Email deliveries have no feed to go absent from, so the gone-from-feed
// reading does not apply to them. Their retention is flat delivery age, the
// same bound every other article's lifetime has: an article is an article,
// and a delivery nobody deletes must still age out, or one active subscriber
// who never removes anything would accumulate rows forever. 90 days is
// several times the dormancy thresholds' default order and comfortably past
// any "read the newsletter eventually" window.
const emailRetentionDays = 90;

const daysAgo = (days: number) => sql`NOW() - (${days} * INTERVAL '1 day')`;

/**
 * Prunes what nothing can still reach: expired users and sessions,
 * subscriberless sources, and articles past every reader's horizon.
 *
 * Returns the ids of the sources whose article rows shrank. The deletes here
 * bypass the data services, so `user_sources.unread_count` still counts
 * removed articles until the caller recomputes it for every returned source
 * (#812) -- without that, a pruned unread newsletter keeps its badge until
 * some unrelated event happens to recount the source.
 */
export async function cleanupOrphanedData(
  drizzleConnection: BunSQLDatabase<typeof schema>,
  userDormantAfterDays: number,
  articleStaleAfterDays: number,
  userExpiryDays: number,
): Promise<number[]> {
  const prunedSourceIds = new Set<number>();
  const rememberPrunedFrom = (removed: { sourceId: number }[]) => {
    for (const row of removed) prunedSourceIds.add(row.sourceId);
  };
  // Runs first: the cascade on user_sources shrinks the "current subscriber"
  // set before every rule below evaluates it, so no rule needs to special-case
  // expired users.
  if (userExpiryDays > 0) {
    await drizzleConnection
      .delete(users)
      .where(lt(users.lastSeenAt, daysAgo(userExpiryDays)));
  }

  // Expired sessions are dead weight, not data: enforcement lives in the
  // session lookup itself, so these rows are unreachable the moment they
  // age out and only the delete is left to do.
  await drizzleConnection
    .delete(sessions)
    .where(lt(sessions.expiresAt, sql`NOW()`));

  // "Delete sources nobody subscribes to" means "delete every source" when
  // user_sources is empty -- correct if the last subscription was just
  // removed, catastrophic if the table is empty for any transient reason.
  // This can't tell those apart, so guard on the whole table existing, in the
  // same statement to leave no check-then-delete race.
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

  const earliestSubs = drizzleConnection
    .select({
      earliestSubscription: min(userSources.createdAt).as(
        "earliest_subscription",
      ),
      sourceId: userSources.sourceId,
    })
    .from(userSources)
    .groupBy(userSources.sourceId)
    .as("earliest_subs");

  const articlesBeforeSubscription = drizzleConnection
    .select({ id: articles.id })
    .from(articles)
    .leftJoin(earliestSubs, eq(articles.sourceId, earliestSubs.sourceId))
    .where(
      and(
        isNotNull(earliestSubs.sourceId),
        lt(articles.lastSeenInFeedAt, earliestSubs.earliestSubscription),
      ),
    );

  rememberPrunedFrom(
    await drizzleConnection
      .delete(articles)
      .where(inArray(articles.id, articlesBeforeSubscription))
      .returning({ sourceId: articles.sourceId }),
  );

  // The complement of the rule above: articles current subscribers COULD see,
  // but which are gone for good -- absent past confirmedGoneFromFeedBuffer and
  // deleted by everyone who could have seen them. "Could have seen" is scoped
  // to subscribers who joined before it disappeared; a later subscriber never
  // had the chance to delete it, so their missing row must not block the prune.
  //
  // A false positive is no longer unrecoverable: user_articles is keyed on
  // (source, guid) with no foreign key to articles, so a removal outlives the
  // prune and a re-inserted article stays removed. The buffer stays because
  // re-fetching content is waste, not because being wrong is destructive.
  //
  // Email sources are excluded from the rule below; they prune separately on
  // flat delivery age (see emailRetentionDays) because they have no feed to
  // be absent from, and each delivery stamps last_success, which would make
  // every earlier newsletter look dropped if read as an absence.
  const articlesUnreachableByAnyone = drizzleConnection
    .select({ id: articles.id })
    .from(articles)
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(
      and(
        isNotNull(sources.lastSuccess),
        ne(sources.kind, "email"),
        lt(
          articles.lastSeenInFeedAt,
          sql`${sources.lastSuccess} - ${confirmedGoneFromFeedBuffer}`,
        ),
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
                        eq(userArticles.sourceId, articles.sourceId),
                        eq(userArticles.guid, articles.guid),
                        isNotNull(userArticles.deletedAt),
                      ),
                    ),
                ),
              ),
            ),
        ),
      ),
    );

  rememberPrunedFrom(
    await drizzleConnection
      .delete(articles)
      .where(inArray(articles.id, articlesUnreachableByAnyone))
      .returning({ sourceId: articles.sourceId }),
  );

  // Email sources prune separately: they have no feed to be absent from, and
  // each delivery stamps last_success, which would make every earlier
  // newsletter look dropped if read as an absence. Instead they age out on
  // flat delivery age (see emailRetentionDays), deletion records not
  // gating it: a delivery is an article like any other, and an active
  // subscriber's missing deletion would otherwise hold every row forever.
  const emailArticlesPastRetention = drizzleConnection
    .select({ id: articles.id })
    .from(articles)
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(
      and(
        eq(sources.kind, "email"),
        lt(articles.lastSeenInFeedAt, daysAgo(emailRetentionDays)),
      ),
    );

  rememberPrunedFrom(
    await drizzleConnection
      .delete(articles)
      .where(inArray(articles.id, emailArticlesPastRetention))
      .returning({ sourceId: articles.sourceId }),
  );

  // Neither rule above accounts for dormancy -- a subscriber who hasn't made a
  // request in months still counts as current. This catches articles old
  // enough that no subscriber who could have seen them is still active,
  // regardless of deletions. Either threshold at 0 disables the rule; 0 never
  // means "no requirement".
  if (userDormantAfterDays > 0 && articleStaleAfterDays > 0) {
    const articlesOnlyDormantCouldSee = drizzleConnection
      .select({ id: articles.id })
      .from(articles)
      .where(
        and(
          lt(articles.lastSeenInFeedAt, daysAgo(articleStaleAfterDays)),
          notExists(
            drizzleConnection
              .select({ id: userSources.id })
              .from(userSources)
              .innerJoin(users, eq(users.id, userSources.userId))
              .where(
                and(
                  eq(userSources.sourceId, articles.sourceId),
                  lte(userSources.createdAt, articles.lastSeenInFeedAt),
                  gt(users.lastSeenAt, daysAgo(userDormantAfterDays)),
                ),
              ),
          ),
        ),
      );

    rememberPrunedFrom(
      await drizzleConnection
        .delete(articles)
        .where(inArray(articles.id, articlesOnlyDormantCouldSee))
        .returning({ sourceId: articles.sourceId }),
    );
  }

  return [...prunedSourceIds];
}

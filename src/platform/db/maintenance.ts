import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  lte,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type * as schema from "#platform/db/schema.ts";
import { articles } from "#platform/db/schemas/articles.ts";
import { sources } from "#platform/db/schemas/sources.ts";
import { userArticles } from "#platform/db/schemas/user-articles.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import { users } from "#platform/db/schemas/users.ts";

// How long an article must go unseen before the feed is believed to have
// dropped it for good. A single fetch omitting an item does NOT mean it is
// gone -- pagination boundaries, ordering changes and transient truncation
// all do that routinely -- so this has to span MANY of the source's own
// fetch cycles, which is what a flat interval fails to do: at the 5-minute
// poll floor one day is ~288 cycles, but a feed advertising a long
// max-age parks itself days out (successSource clamps the floor, never the
// ceiling), and a websub source only falls back to polling once a day. For
// those, a flat day is less than a single cycle -- no grace at all, which
// is exactly the false positive that made this rule destroy 89k articles'
// deletion records once already.
//
// So scale it by the source's own cadence. not_before and last_success are
// written by the same successSource UPDATE, so their difference is the
// refresh interval the origin itself asked for; websub polls on a flat
// daily fallback that ignores that column entirely. Every degenerate case
// (never-set not_before, a long failure backoff) lands on a LARGER buffer,
// which errs towards keeping an article rather than deleting one.
const confirmedGoneFromFeedBuffer = sql`
  GREATEST(
    INTERVAL '1 day',
    10 * CASE ${sources.kind}
      WHEN 'websub' THEN INTERVAL '1 day'
      ELSE ${sources.notBefore} - ${sources.lastSuccess}
    END
  )
`;

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
          earliestSubscription: sql<Date>`min(${userSources.createdAt})`.as(
            "earliest_subscription",
          ),
          sourceId: userSources.sourceId,
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
  //
  // The deletion is only as safe as that "gone for good" signal: removals
  // live in user_articles keyed on articles.id and cascade away with the
  // row, so a false positive doesn't just delete an article, it forgets
  // that anyone ever removed it -- and the next fetch listing the item
  // again re-inserts it under a fresh serial id, unread. Hence the
  // cadence-scaled buffer above, and hence email sources being excluded
  // outright: they have no feed to be absent from. Each delivery upserts
  // one article and stamps last_success (for the admin's "last via"
  // column), which under a plain last_seen < last_success comparison
  // makes every earlier newsletter look dropped from a feed that does
  // not exist.
  const articlesUnreachableByAnyone = drizzleConnection
    .select({ id: articles.id })
    .from(articles)
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(
      and(
        isNotNull(sources.lastSuccess),
        ne(sources.kind, "email"),
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

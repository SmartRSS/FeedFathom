import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  lt,
  min,
  ne,
  not,
  notExists,
  sql,
} from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { AppConfig } from "#platform/config.ts";
import type * as schema from "#platform/db/schema.ts";
import { articles } from "#platform/db/schemas/articles.ts";
import { sessions } from "#platform/db/schemas/sessions.ts";
import { sources } from "#platform/db/schemas/sources.ts";
import { userArticles } from "#platform/db/schemas/user-articles.ts";
import { userSources } from "#platform/db/schemas/user-sources.ts";
import { users } from "#platform/db/schemas/users.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { webSubFallbackPollMs } from "#features/feeds/source-schedule-policy.ts";
import { subscriptionSeesArticle } from "#features/feeds/article-read-state.ts";

const goneFromFeedBufferFloorHours = 24;
const confirmedGoneFromFeedBuffer = sql`
  GREATEST(
    ${goneFromFeedBufferFloorHours} * INTERVAL '1 hour',
    10 * CASE ${sources.kind}
      WHEN 'websub' THEN ${webSubFallbackPollMs} * INTERVAL '1 millisecond'
      ELSE ${sources.notBefore} - ${sources.lastSuccess}
    END
  )
`;

export const lastSeenBumpThrottleHours = 1;

const emailRetentionDays = 90;

const subscriberlessGraceEnd = sql`NOW() - INTERVAL '1 day'`;
export const inSubscriberlessGrace = gt(
  sources.createdAt,
  subscriberlessGraceEnd,
);
export const hasSubscriber = (
  db: Pick<BunSQLDatabase<typeof schema>, "select">,
) =>
  exists(
    db
      .select({ id: userSources.id })
      .from(userSources)
      .where(eq(userSources.sourceId, sources.id)),
  );

const daysAgo = (days: number) => sql`NOW() - (${days} * INTERVAL '1 day')`;

export class RetentionService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
    private readonly userSourcesDataService: Pick<
      UserSourcesDataService,
      "recomputeUnreadCounts"
    >,
    private readonly config: Pick<
      AppConfig,
      | "ARTICLE_STALE_AFTER_DAYS"
      | "USER_DORMANT_AFTER_DAYS"
      | "USER_EXPIRY_DAYS"
    >,
  ) {}

  public async prune() {
    const prunedSourceIds = await deleteUnreachableRows(
      this.drizzleConnection,
      this.config.USER_DORMANT_AFTER_DAYS,
      this.config.ARTICLE_STALE_AFTER_DAYS,
      this.config.USER_EXPIRY_DAYS,
    );
    await this.userSourcesDataService.recomputeUnreadCounts(prunedSourceIds);
  }
}

async function deleteUnreachableRows(
  drizzleConnection: BunSQLDatabase<typeof schema>,
  userDormantAfterDays: number,
  articleStaleAfterDays: number,
  userExpiryDays: number,
): Promise<number[]> {
  const prunedSourceIds = new Set<number>();
  const rememberPrunedFrom = (removed: { sourceId: number }[]) => {
    for (const row of removed) prunedSourceIds.add(row.sourceId);
  };
  if (userExpiryDays > 0) {
    const cutoff = new Date(Date.now() - userExpiryDays * 86_400_000);
    await drizzleConnection.execute(sql`
      UPDATE sources s SET reserved_by = (
        SELECT us.user_id FROM user_sources us
        JOIN users u ON u.id = us.user_id
        WHERE us.source_id = s.id AND u.last_seen_at >= ${cutoff}
        ORDER BY us.created_at, us.id
        LIMIT 1
      )
      FROM users owner
      WHERE owner.id = s.reserved_by AND owner.last_seen_at < ${cutoff}
        AND EXISTS (
          SELECT 1 FROM user_sources us
          JOIN users u ON u.id = us.user_id
          WHERE us.source_id = s.id AND u.last_seen_at >= ${cutoff}
        )
    `);
    await drizzleConnection.delete(users).where(lt(users.lastSeenAt, cutoff));
  }

  await drizzleConnection
    .delete(sessions)
    .where(lt(sessions.expiresAt, sql`NOW()`));

  const subscriberless = and(
    not(inSubscriberlessGrace),
    exists(drizzleConnection.select({ id: userSources.id }).from(userSources)),
    not(hasSubscriber(drizzleConnection)),
  );

  const tombstone = and(
    isNotNull(sources.reservedBy),
    isNotNull(sources.lastSuccess),
  )!;
  await drizzleConnection
    .delete(sources)
    .where(and(subscriberless, not(tombstone)));
  await drizzleConnection
    .delete(articles)
    .where(
      inArray(
        articles.sourceId,
        drizzleConnection
          .select({ id: sources.id })
          .from(sources)
          .where(and(subscriberless, tombstone)),
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
    .innerJoin(earliestSubs, eq(articles.sourceId, earliestSubs.sourceId))
    .where(
      not(
        subscriptionSeesArticle(
          articles.lastSeenInFeedAt,
          earliestSubs.earliestSubscription,
        ),
      ),
    );

  rememberPrunedFrom(
    await drizzleConnection
      .delete(articles)
      .where(inArray(articles.id, articlesBeforeSubscription))
      .returning({ sourceId: articles.sourceId }),
  );

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
                subscriptionSeesArticle(
                  articles.lastSeenInFeedAt,
                  userSources.createdAt,
                ),
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
                  subscriptionSeesArticle(
                    articles.lastSeenInFeedAt,
                    userSources.createdAt,
                  ),
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

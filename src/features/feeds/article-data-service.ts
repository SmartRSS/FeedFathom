import { aliasedTable, and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { articlePageSize } from "#shared/contracts/responses.ts";
import {
  articleFilterCondition,
  readCondition,
  type ArticleFilter,
} from "#features/feeds/article-read-state.ts";
import {
  generateBoundaryDates,
  getDateGroup,
} from "#shared/util/get-date-group.ts";
import { userSources } from "#platform/db/schema.ts";
import type * as schema from "#platform/db/schema.ts";
import { type ArticleInsert, articles } from "#platform/db/schemas/articles.ts";
import { userArticles } from "#platform/db/schemas/user-articles.ts";
import { lastSeenBumpThrottleHours } from "#features/feeds/retention.ts";

// user_articles is keyed on the article's (source, guid) rather than its id,
// so a removal survives the article row being pruned -- see the schema.
function userArticleStateJoin(userId: number) {
  return and(
    eq(userArticles.userId, userId),
    eq(userArticles.sourceId, articles.sourceId),
    eq(userArticles.guid, articles.guid),
  );
}

// The page cursor names a row rather than carrying its timestamp, so the
// query has to look at articles twice.
const cursorRow = aliasedTable(articles, "cursor_row");

function userArticleAccessJoin(userId: number) {
  return and(
    eq(userSources.userId, userId),
    eq(userSources.sourceId, articles.sourceId),
    gte(articles.lastSeenInFeedAt, userSources.createdAt),
  );
}

export class ArticlesDataService {
  constructor(
    private readonly drizzleConnection: BunSQLDatabase<typeof schema>,
  ) {}

  // Columns are listed rather than selecting the whole row: articles carries
  // a generated tsvector for search (#697), and neither the reader nor the
  // article response has any use for a copy of the body split into lexemes.
  public async getUserArticle(articleId: number, userId: number) {
    return (
      await this.drizzleConnection
        .select({
          author: articles.author,
          content: articles.content,
          guid: articles.guid,
          id: articles.id,
          lastSeenInFeedAt: articles.lastSeenInFeedAt,
          publishedAt: articles.publishedAt,
          sourceId: articles.sourceId,
          title: articles.title,
          updatedAt: articles.updatedAt,
          url: articles.url,
        })
        .from(articles)
        .innerJoin(userSources, userArticleAccessJoin(userId))
        .where(eq(articles.id, articleId))
        .limit(1)
    ).at(0);
  }

  public async getUserArticlesForSources(
    sourceIds: number[],
    userId: number,
    cursor?: number,
    filter: ArticleFilter = "unread",
    options: {
      // Scope to every source the user subscribes to instead of an explicit
      // id list -- the userSources join is what authorizes the rows, so
      // this is safe with sources left empty.
      allSubscribed?: boolean;
      // Only articles published within this many hours of now.
      publishedWithinHours?: number;
      // Full-text search (#697): matched against the stored tsvector over
      // title and body. An empty or stopword-only query matches nothing,
      // which is what an empty tsquery does rather than something special
      // here.
      query?: string;
    } = {},
  ) {
    if (!options.allSubscribed && sourceIds.length === 0) {
      return [];
    }

    const readStateColumns = {
      articleUpdatedAt: articles.updatedAt,
      deletedAt: userArticles.deletedAt,
      readAt: userArticles.readAt,
      userId: userArticles.userId,
    };
    const loadedArticles = await this.drizzleConnection
      .select({
        author: articles.author,
        id: articles.id,
        publishedAt: articles.publishedAt,
        // Answered by the same expression that filters, so the "all" view
        // cannot mark a row read that the "read" view would not have listed.
        read: sql<boolean>`${readCondition(readStateColumns)}`,
        sourceId: articles.sourceId,
        title: articles.title,
        url: articles.url,
      })
      .from(articles)
      .leftJoin(userArticles, userArticleStateJoin(userId))
      .leftJoin(userSources, userArticleAccessJoin(userId))
      .where(
        and(
          // The time window rides the same index as the source filter
          // (articles_source_published_idx), so the Today query stays a
          // plain range scan.
          ...(options.allSubscribed
            ? []
            : [inArray(articles.sourceId, sourceIds)]),
          ...(options.publishedWithinHours
            ? [
                sql`${articles.publishedAt} >= NOW() - (${options.publishedWithinHours} * INTERVAL '1 hour')`,
              ]
            : []),
          // Search rides the GIN index on the same generated column the
          // schema defines, and stays inside the keyset paging above rather
          // than ordering by ts_rank: a rank order has no cursor, and the
          // list this feeds pages by (published_at, id).
          // ponytail: newest-first, not best-first. Rank ordering needs a
          // cursor over (rank, id) before it can page.
          ...(options.query
            ? [
                sql`${articles.searchVector} @@ plainto_tsquery('english', ${options.query})`,
              ]
            : []),
          // Unread is shared with recomputeUnreadCounts, so the list and the
          // badge beside the source cannot disagree about what it means. A
          // removal is terminal and hidden in every filter -- exactly as
          // recomputeUnreadCounts scores it.
          articleFilterCondition(filter, readStateColumns),
          // Snoozed sources (#725) never surface as unread while the pause
          // is active. The timestamp is tested lazily here at read time, so
          // expiry needs no job: the backlog accumulated during the pause
          // is still stored unread and reappears on its own. The "all" and
          // "read" views are unsuppressed, so the backlog stays reachable.
          ...(filter === "unread"
            ? [
                sql`(${userSources.pausedUntil} IS NULL OR ${userSources.pausedUntil} <= NOW())`,
              ]
            : []),
          // Ensure the userSources join matched (article appeared after subscription)
          sql`${userSources.createdAt} IS NOT NULL`,
          // Keyset rather than OFFSET: a folder fanning out to hundreds of
          // sources would otherwise make every page rescan everything above
          // it, and a page-sized LIMIT is the only thing bounding what this
          // loads into memory and serialises. The cursor row's timestamp is
          // read back here so it keeps full microsecond precision; a value
          // round-tripped through the client's JSON date is milliseconds and
          // lands inside the batch it was meant to sit after.
          cursor
            ? sql`(${articles.publishedAt}, ${articles.id}) < (
                (SELECT ${cursorRow.publishedAt} FROM ${articles} ${cursorRow} WHERE ${cursorRow.id} = ${cursor}),
                ${cursor}
              )`
            : undefined,
        ),
      )
      // id breaks the tie: published_at is not unique, and a keyset cursor on
      // an ambiguous ordering repeats or skips rows across pages.
      .orderBy(desc(articles.publishedAt), desc(articles.id))
      .limit(articlePageSize);

    const boundaryDates = generateBoundaryDates();
    return loadedArticles.map((item) =>
      Object.assign(
        { group: getDateGroup(boundaryDates, item.publishedAt) },
        item,
      ),
    );
  }

  /**
   * Returns how many rows a recount of the unread badge could now see
   * differently: articles inserted, articles whose content or timestamps
   * changed, and articles a newer subscription could not see until this
   * write re-stamped them. Zero means nothing a badge counts has moved.
   */
  public async batchUpsertArticles(
    articlePayloads: ArticleInsert[],
  ): Promise<number> {
    // A feed can list the same (sourceId, guid) twice in one fetch (republishing,
    // pagination overlap, feed-generator bugs). Postgres rejects an ON CONFLICT
    // DO UPDATE batch that targets the same row twice, so dedupe first, keeping
    // the last occurrence as the freshest data.
    const deduped = [
      ...new Map(
        articlePayloads.map((payload) => [
          `${payload.sourceId} ${payload.guid}`,
          payload,
        ]),
      ).values(),
    ];

    const fieldChange = sql`
      excluded.author IS DISTINCT FROM ${articles.author}
      OR excluded.content IS DISTINCT FROM ${articles.content}
      OR excluded.title IS DISTINCT FROM ${articles.title}
      OR excluded.url IS DISTINCT FROM ${articles.url}
      OR (
        excluded.updated_at IS NOT NULL
        AND excluded.published_at IS DISTINCT FROM ${articles.publishedAt}
      )
    `;
    const timestampAdvance = sql`
      excluded.updated_at IS NOT NULL
      AND (
        ${articles.updatedAt} IS NULL
        OR excluded.updated_at > ${articles.updatedAt}
      )
    `;
    // At 10 columns a row this is about 1000 bind parameters, far under
    // Postgres's 65535, and puts a typical feed in one round trip.
    const BATCH_SIZE = 100;
    // Split per source so the latest-subscription lookup below is an
    // uncorrelated subquery, which Postgres evaluates once per statement.
    const batches = [];
    for (const sourcePayloads of Map.groupBy(
      deduped,
      (payload) => payload.sourceId,
    ).values()) {
      for (let i = 0; i < sourcePayloads.length; i += BATCH_SIZE) {
        batches.push(sourcePayloads.slice(i, i + BATCH_SIZE));
      }
    }

    let changed = 0;
    for (const [batchIndex, batch] of batches.entries()) {
      const sourceId = batch[0]!.sourceId;
      // A subscription sees an article once last_seen_in_feed_at reaches its
      // created_at (userArticleAccessJoin), and OPML import creates
      // subscriptions without writing any article. A stamp older than the
      // newest subscription is therefore moved regardless of the throttle,
      // or that subscriber would wait up to the throttle to see the feed.
      const latestSubscription = sql`(
        SELECT MAX(${userSources.createdAt})
        FROM ${userSources}
        WHERE ${userSources.sourceId} = ${sourceId}
      )`;
      // Compared as text: a JS Date drops the microseconds, and the
      // content-change branch below can move updated_at by exactly one.
      const updatedAtText = sql<null | string>`${articles.updatedAt}::text`;
      try {
        // RETURNING sees only the new row, so what each row looked like
        // before is read first. The SET moves updated_at exactly when
        // fieldChange or timestampAdvance holds, which is what separates a
        // content change from a bare re-stamp. A concurrent write in between
        // can only make this over-report, which costs one recount.
        // eslint-disable-next-line no-await-in-loop -- Sequential batches bound database pressure.
        const before = await this.drizzleConnection
          .select({
            guid: articles.guid,
            hidden: sql<boolean>`COALESCE(${articles.lastSeenInFeedAt} < ${latestSubscription}, false)`,
            updatedAt: updatedAtText,
          })
          .from(articles)
          .where(
            and(
              eq(articles.sourceId, sourceId),
              inArray(
                articles.guid,
                batch.map((payload) => payload.guid),
              ),
            ),
          );
        const beforeByGuid = new Map(before.map((row) => [row.guid, row]));

        // eslint-disable-next-line no-await-in-loop -- Sequential batches bound database pressure.
        const written = await this.drizzleConnection
          .insert(articles)
          .values(batch)
          .onConflictDoUpdate({
            set: {
              author: sql`excluded.author`,
              content: sql`excluded.content`,
              lastSeenInFeedAt: sql`excluded.last_seen_in_feed_at`,
              publishedAt: sql`
                CASE
                  WHEN excluded.updated_at IS NOT NULL THEN excluded.published_at
                  ELSE ${articles.publishedAt}
                END
              `,
              title: sql`excluded.title`,
              updatedAt: sql`
                CASE
                  WHEN ${fieldChange} THEN
                    CASE
                      WHEN ${timestampAdvance} THEN excluded.updated_at
                      ELSE GREATEST(
                        excluded.last_seen_in_feed_at,
                        COALESCE(
                          ${articles.updatedAt} + INTERVAL '1 microsecond',
                          '-infinity'::timestamp
                        )
                      )
                    END
                  WHEN ${timestampAdvance} THEN excluded.updated_at
                  ELSE ${articles.updatedAt}
                END
              `,
              url: sql`excluded.url`,
            },
            // An unchanged row is left alone until its stamp is
            // lastSeenBumpThrottleHours old (#897). Every write here copies
            // the whole row, body included, into every index on the table,
            // and a poll every few minutes made nearly all of them no-ops.
            // retention.ts explains why the throttle must stay under the
            // gone-from-feed buffer.
            setWhere: sql`
              excluded.last_seen_in_feed_at >= ${articles.lastSeenInFeedAt}
              AND (
                ${fieldChange}
                OR ${timestampAdvance}
                OR ${articles.lastSeenInFeedAt} < GREATEST(
                  excluded.last_seen_in_feed_at - ${lastSeenBumpThrottleHours} * INTERVAL '1 hour',
                  ${latestSubscription}
                )
              )
            `,
            target: [articles.sourceId, articles.guid],
          })
          .returning({ guid: articles.guid, updatedAt: updatedAtText });

        for (const row of written) {
          const previous = beforeByGuid.get(row.guid);
          if (
            previous === undefined ||
            previous.hidden ||
            previous.updatedAt !== row.updatedAt
          ) {
            changed++;
          }
        }
      } catch (error) {
        console.error(
          `Error upserting articles batch ${batchIndex + 1}/${batches.length}:`,
          error,
        );
        console.error(
          `Batch size: ${batch.length}, Total articles: ${articlePayloads.length}`,
        );
        throw error;
      }
    }
    return changed;
  }

  /**
   * Marks articles read or unread for one user.
   *
   * Shares `removeUserArticles`'s authorization: article ids are a guessable
   * serial primary key, so the caller's list is filtered down to articles
   * whose source this user is actually subscribed to before anything is
   * written. `deleted_at` is left alone -- read and removed are different
   * states, and a removal outranks either of them.
   */
  public async setUserArticlesRead(
    articleIdList: number[],
    userId: number,
    read: boolean,
  ): Promise<{ articleIds: number[]; sourceIds: number[] }> {
    if (articleIdList.length === 0) {
      return { articleIds: [], sourceIds: [] };
    }

    const readAt = read ? new Date() : null;

    return await this.drizzleConnection.transaction(async (trx) => {
      const authorizedArticles = await trx
        .selectDistinct({
          guid: articles.guid,
          id: articles.id,
          sourceId: articles.sourceId,
        })
        .from(articles)
        .innerJoin(userSources, userArticleAccessJoin(userId))
        .where(inArray(articles.id, articleIdList));

      if (authorizedArticles.length === 0) {
        return { articleIds: [], sourceIds: [] };
      }

      await trx
        .insert(userArticles)
        .values(
          authorizedArticles.map((row) => ({
            guid: row.guid,
            readAt,
            sourceId: row.sourceId,
            userId,
          })),
        )
        .onConflictDoUpdate({
          set: { readAt },
          target: [
            userArticles.userId,
            userArticles.sourceId,
            userArticles.guid,
          ],
        });

      return {
        articleIds: authorizedArticles.map((row) => row.id),
        sourceIds: [...new Set(authorizedArticles.map((row) => row.sourceId))],
      };
    });
  }

  public async removeUserArticles(
    articleIdList: number[],
    userId: number,
  ): Promise<{ articleIds: number[]; sourceIds: number[] }> {
    if (articleIdList.length === 0) {
      return { articleIds: [], sourceIds: [] };
    }

    const now = new Date();

    return await this.drizzleConnection.transaction(async (trx) => {
      // Only allow soft-deleting articles whose source the user is actually
      // subscribed to; article IDs are a guessable serial PK so we can't
      // trust the caller-supplied list as-is.
      const authorizedArticles = await trx
        .selectDistinct({
          guid: articles.guid,
          id: articles.id,
          sourceId: articles.sourceId,
        })
        .from(articles)
        .innerJoin(userSources, userArticleAccessJoin(userId))
        .where(inArray(articles.id, articleIdList));

      if (authorizedArticles.length === 0) {
        return { articleIds: [], sourceIds: [] };
      }

      const articleIds = authorizedArticles.map((row) => row.id);
      const values = authorizedArticles.map((row) => {
        return {
          deletedAt: now,
          guid: row.guid,
          sourceId: row.sourceId,
          userId,
        };
      });

      await trx
        .insert(userArticles)
        .values(values)
        .onConflictDoUpdate({
          set: { deletedAt: now },
          target: [
            userArticles.userId,
            userArticles.sourceId,
            userArticles.guid,
          ],
        });

      const sourceIds = [
        ...new Set(authorizedArticles.map((row) => row.sourceId)),
      ];
      return { articleIds, sourceIds };
    });
  }
}

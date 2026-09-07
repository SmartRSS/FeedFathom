import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * The columns an unread test needs, from whichever aliases the caller's query
 * happens to use.
 */
export type ReadStateColumns = {
  articleUpdatedAt: SQLWrapper;
  deletedAt: SQLWrapper;
  readAt: SQLWrapper;
  userId: SQLWrapper;
};

/**
 * The one definition of "this article still counts as unread for this user".
 *
 * It has to be one definition because two queries answer with it -- the
 * article list and `recomputeUnreadCounts`, which fills the badge beside every
 * source -- and a disagreement between them shows up as an unread count with
 * nothing behind it. They had already drifted: the list ANDed
 * `updated_at > read_at` onto the removal test, and in SQL `x > NULL` is NULL,
 * so a row with `deleted_at IS NULL` and `read_at IS NULL` made the whole
 * expression NULL and dropped the article out of the list while the count
 * still called it unread. Nothing wrote `read_at`, so nothing hit it; the
 * first commit that did would have.
 *
 * Unread means: no state row at all, or a row that is not a removal and
 * either has never been read or has been edited by the publisher since it was.
 * That last clause is why `read_at` is compared to `articles.updated_at`
 * rather than just tested for NULL -- a post you read and the author then
 * rewrote is worth seeing again.
 */
export const unreadCondition = (columns: ReadStateColumns): SQL =>
  sql`(
    ${columns.userId} IS NULL
    OR (
      ${columns.deletedAt} IS NULL
      AND (
        ${columns.readAt} IS NULL
        OR ${columns.articleUpdatedAt} > ${columns.readAt}
      )
    )
  )`;

/**
 * A removal is terminal and stays hidden in every filter. Read and unread are
 * the two halves of what is left, and they partition it: an article that is
 * not removed is in exactly one of them, whichever way `updated_at` and
 * `read_at` fall. The integration test holds them to that.
 */
const notRemovedCondition = (columns: ReadStateColumns): SQL =>
  sql`(${columns.userId} IS NULL OR ${columns.deletedAt} IS NULL)`;

/**
 * The complement of {@link unreadCondition} within the articles that are not
 * removed. `updated_at IS NULL` has to be spelled out rather than left to
 * `NOT (updated_at > read_at)`: an article nobody has edited has no
 * `updated_at` at all, and in SQL that comparison is NULL, not false.
 */
export const readCondition = (columns: ReadStateColumns): SQL =>
  sql`(
    ${columns.userId} IS NOT NULL
    AND ${columns.deletedAt} IS NULL
    AND ${columns.readAt} IS NOT NULL
    AND (
      ${columns.articleUpdatedAt} IS NULL
      OR ${columns.articleUpdatedAt} <= ${columns.readAt}
    )
  )`;

/** Which articles a list request wants. Unread is what the app has shown all along. */
export type ArticleFilter = "all" | "read" | "unread";

export const articleFilterCondition = (
  filter: ArticleFilter,
  columns: ReadStateColumns,
): SQL => {
  if (filter === "unread") return unreadCondition(columns);
  if (filter === "read") return readCondition(columns);
  return notRemovedCondition(columns);
};

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Static } from "typebox";
import type { articlesRequest } from "#shared/contracts/requests.ts";

export const subscriptionSeesArticle = (
  articleLastSeen: SQLWrapper,
  subscribedAt: SQLWrapper,
): SQL => sql`${articleLastSeen} >= ${subscribedAt}`;

type ReadStateColumns = {
  articleUpdatedAt: SQLWrapper;
  deletedAt: SQLWrapper;
  readAt: SQLWrapper;
  userId: SQLWrapper;
};

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

const notRemovedCondition = (columns: ReadStateColumns): SQL =>
  sql`(${columns.userId} IS NULL OR ${columns.deletedAt} IS NULL)`;

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

export type ArticleFilter = NonNullable<
  Static<typeof articlesRequest>["filter"]
>;

export const articleFilterCondition = (
  filter: ArticleFilter,
  columns: ReadStateColumns,
): SQL => {
  if (filter === "unread") return unreadCondition(columns);
  if (filter === "read") return readCondition(columns);
  return notRemovedCondition(columns);
};

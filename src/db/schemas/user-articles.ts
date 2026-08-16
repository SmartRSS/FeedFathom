import {
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
} from "drizzle-orm/pg-core";
import { articles } from "./articles.ts";
import { users } from "./users.ts";

export const userArticles = pgTable(
  "user_articles",
  {
    articleId: integer("article_id")
      .references(() => articles.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      })
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.articleId] }),
    index("user_articles_user_id_idx").on(table.userId),
    // Composite, not just (article_id): getUserArticlesForSources joins on
    // both columns together, and article_id alone (this index's former
    // shape) forced a per-row filter after the index lookup instead of an
    // exact match.
    index("user_articles_article_user_idx").on(table.articleId, table.userId),
    index("user_articles_user_read_idx").on(table.userId, table.readAt),
  ],
);

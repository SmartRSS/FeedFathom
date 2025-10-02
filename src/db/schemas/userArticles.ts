import {
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
} from "drizzle-orm/pg-core";
import { articles } from "./articles";
import { users } from "./users";

export const userArticles = pgTable(
  "user_articles",
  {
    articleId: integer("article_id")
      .references(() => articles.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      })
      .notNull(),
    deletedAt: timestamp("deleted_at"),
    readAt: timestamp("read_at"),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.articleId] }),
    index("user_articles_user_id_idx").on(table.userId),
    index("user_articles_article_id_idx").on(table.articleId),
    index("user_articles_user_read_idx").on(table.userId, table.readAt),
    index("user_articles_user_article_idx").on(table.userId, table.articleId),
  ],
);

export type UserArticle = typeof userArticles.$inferSelect;
export type UserArticleInsert = typeof userArticles.$inferInsert;

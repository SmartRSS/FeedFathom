import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sources } from "./sources";
import { userArticles } from "./userArticles";

export const articles = pgTable(
  "articles",
  {
    author: varchar("author").notNull(),
    content: text("content").notNull(),
    guid: varchar("guid").notNull().unique(),
    id: serial("id").primaryKey(),
    publishedAt: timestamp("published_at").notNull(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    title: varchar("title").notNull(),
    updatedAt: timestamp("updated_at"),
    url: varchar("url").notNull(),
    lastSeenInFeedAt: timestamp("last_seen_in_feed_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [index("last_seen_in_feed_at_idx").on(table.lastSeenInFeedAt)],
);

export type Article = typeof articles.$inferSelect;
export type ArticleInsert = typeof articles.$inferInsert;

export const articleUserArticlesRelation = relations(articles, ({ many }) => {
  return {
    userArticles: many(userArticles),
  };
});

export const articlesSourceRelation = relations(articles, ({ one }) => {
  return {
    source: one(sources, {
      fields: [articles.sourceId],
      references: [sources.id],
    }),
  };
});

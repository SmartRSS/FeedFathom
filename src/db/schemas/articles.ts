import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sources } from "./sources";

export const articles = pgTable(
  "articles",
  {
    author: varchar("author").notNull(),
    content: text("content").notNull(),
    guid: varchar("guid").notNull(),
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
  (table) => [
    check(
      "articles_url_safe",
      sql`${table.url} = '' OR ${table.url} ~* '^https?://' OR ${table.url} LIKE '/article/%'`,
    ),
    index("last_seen_in_feed_at_idx").on(table.lastSeenInFeedAt),
    index("articles_source_published_idx").on(
      table.sourceId,
      table.publishedAt,
    ),
    index("articles_source_last_seen_idx").on(
      table.sourceId,
      table.lastSeenInFeedAt,
    ),
    index("articles_updated_at_idx").on(table.updatedAt),
    unique().on(table.sourceId, table.guid),
  ],
);

export type Article = typeof articles.$inferSelect;
export type ArticleInsert = typeof articles.$inferInsert;

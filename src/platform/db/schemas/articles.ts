import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sources } from "#platform/db/schemas/sources.ts";

export const articles = pgTable(
  "articles",
  {
    author: varchar("author").notNull(),
    content: text("content").notNull(),
    guid: varchar("guid").notNull(),
    // Every upsert attempt burns a sequence value whether it inserts or
    // conflicts, so this counter climbs by millions a day for a table of
    // thousands of rows -- a 32-bit serial had a dated end.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    title: varchar("title").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    url: varchar("url").notNull(),
    lastSeenInFeedAt: timestamp("last_seen_in_feed_at", { withTimezone: true })
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

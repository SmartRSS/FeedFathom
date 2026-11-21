import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sources } from "#platform/db/schemas/sources.ts";
import type { Enclosure } from "#shared/contracts/responses.ts";

const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

const enclosuresJsonb = customType<{
  data: Enclosure[];
  driverData: Enclosure[];
}>({ dataType: () => "jsonb" });

export const articles = pgTable(
  "articles",
  {
    author: varchar("author").notNull(),
    content: text("content").notNull(),
    enclosures: enclosuresJsonb("enclosures")
      .notNull()
      .default(sql`'[]'::jsonb`),
    guid: varchar("guid").notNull(),
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    title: varchar("title").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    url: varchar("url").notNull(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', "title"), 'A') || setweight(to_tsvector('english', "content"), 'B')`,
    ),
    lastSeenInFeedAt: timestamp("last_seen_in_feed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    sanitizedVersion: integer("sanitized_version").notNull().default(0),
  },
  (table) => [
    check(
      "articles_url_safe",
      sql`${table.url} = '' OR ${table.url} ~* '^https?://' OR ${table.url} LIKE '/article/%'`,
    ),
    index("last_seen_in_feed_at_idx").on(table.lastSeenInFeedAt),
    index("articles_published_id_idx").on(table.publishedAt, table.id),
    index("articles_source_published_covering_idx").on(
      table.sourceId,
      table.publishedAt,
      table.id,
      table.guid,
      table.lastSeenInFeedAt,
      table.updatedAt,
    ),
    index("articles_source_last_seen_idx").on(
      table.sourceId,
      table.lastSeenInFeedAt,
    ),
    index("articles_search_idx").using("gin", table.searchVector),
    unique().on(table.sourceId, table.guid),
  ],
);

export type ArticleInsert = typeof articles.$inferInsert;

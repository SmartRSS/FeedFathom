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

// Search (#697) is Postgres-native, so the column type is too. drizzle has no
// tsvector builder; nothing reads this column in TypeScript -- it exists for
// the GIN index and the @@ match -- so the mapped type is only a placeholder.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

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
    // Article search (#697): title weighted above body, both stemmed with
    // `english`, per the decision on that issue. The regconfig has to be
    // spelled out or the expression is not immutable and Postgres refuses to
    // store it. `content` is sanitised HTML; the default parser classifies
    // tags as a token type the `english` configuration does not map, so they
    // fall out of the vector rather than becoming search terms.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      // Unqualified column names: a generated expression may only read its
      // own row, and the table it belongs to is still being defined here.
      sql`setweight(to_tsvector('english', "title"), 'A') || setweight(to_tsvector('english', "content"), 'B')`,
    ),
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
    index("articles_search_idx").using("gin", table.searchVector),
    unique().on(table.sourceId, table.guid),
  ],
);

export type ArticleInsert = typeof articles.$inferInsert;

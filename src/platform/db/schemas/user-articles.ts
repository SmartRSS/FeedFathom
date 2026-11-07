import {
  integer,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sources } from "#platform/db/schemas/sources.ts";
import { users } from "#platform/db/schemas/users.ts";

// Deliberately keyed on the article's natural identity -- (source, guid) --
// rather than on articles.id, and with no foreign key to articles at all.
// A cascade from articles would forget a removal as soon as pruning misjudged
// a feed window once (a window that shrinks for a day is enough): the next
// fetch listing that guid again would bring it back unread under a fresh id.
// Keyed this way, the removal outlives the article row, and the re-inserted
// article matches the same (source, guid) and comes back already removed.
//
// ponytail: a removal for a guid the feed never lists again is kept forever
// (it still cascades away with its source or its user). At ~66 bytes a row
// that is thousands of rows a year here; add a sweep if it ever gets big.
export const userArticles = pgTable(
  "user_articles",
  {
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    guid: varchar("guid").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    sourceId: integer("source_id")
      .references(() => sources.id, { onDelete: "cascade" })
      .notNull(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => [
    // Every read of this table is "this user's state for these articles",
    // so the primary key serves all of them and no secondary index does.
    primaryKey({ columns: [table.userId, table.sourceId, table.guid] }),
  ],
);

import {
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sources } from "#platform/db/schemas/sources.ts";
import { users } from "#platform/db/schemas/users.ts";

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
    primaryKey({ columns: [table.userId, table.sourceId, table.guid] }),
    index("user_articles_source_id_idx").on(table.sourceId),
    index("user_articles_covering_idx").on(
      table.userId,
      table.sourceId,
      table.guid,
      table.readAt,
      table.deletedAt,
    ),
  ],
);

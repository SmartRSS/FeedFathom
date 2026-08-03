import { sql } from "drizzle-orm";
import {
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
import { userFolders } from "./userFolders";
import { users } from "./users";

export const userSources = pgTable(
  "user_sources",
  {
    id: serial("id").primaryKey(),
    initializedAt: timestamp("initialized_at"),
    initializationOwner: varchar("initialization_owner"),
    initializationSnapshot: text("initialization_snapshot"),
    initializingAt: timestamp("initializing_at"),
    name: varchar("name").notNull(),
    parentId: integer("parent_id").references(() => userFolders.id, {
      onDelete: "cascade",
    }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`'1970-01-01 00:00:00'::timestamp`),
    unreadCount: integer("unread_count").notNull().default(0),
  },
  (table) => [
    unique().on(table.userId, table.sourceId),
    index("user_sources_user_id_idx").on(table.userId),
    index("user_sources_source_id_idx").on(table.sourceId),
    index("user_sources_user_source_idx").on(table.userId, table.sourceId),
  ],
);

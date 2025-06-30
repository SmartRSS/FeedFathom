import { integer, pgTable, serial, unique, varchar } from "drizzle-orm/pg-core";
import { sources } from "./sources";
import { userFolders } from "./userFolders";
import { users } from "./users";

export const userSources = pgTable(
  "user_sources",
  {
    id: serial("id").primaryKey(),
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
  },
  (table) => [unique().on(table.userId, table.sourceId)],
);

export type UserSource = typeof userSources.$inferSelect;
export type UserSourceInsert = typeof userSources.$inferInsert;

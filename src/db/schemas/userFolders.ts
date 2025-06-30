import {
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const userFolders = pgTable("user_folders", {
  createdAt: timestamp("created_at").notNull().defaultNow(),
  id: serial("id").primaryKey(),
  name: varchar("name").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export type UserFolder = typeof userFolders.$inferSelect;
export type UserFolderInsert = typeof userFolders.$inferInsert;

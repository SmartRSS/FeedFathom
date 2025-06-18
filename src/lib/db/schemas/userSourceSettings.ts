import { integer, pgTable, serial, varchar } from "drizzle-orm/pg-core";
import { userSources } from "./userSources";

export const userSourceSettings = pgTable("user_source_settings", {
  id: serial("id").primaryKey(),
  settings: varchar("settings").notNull(),
  userSource: integer("user_source")
    .references(() => userSources.id, { onDelete: "cascade" })
    .notNull(),
});

export type UserSourceSetting = typeof userSourceSettings.$inferSelect;
export type UserSourceSettingInsert = typeof userSourceSettings.$inferInsert;

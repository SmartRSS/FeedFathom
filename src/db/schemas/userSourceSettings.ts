import { index, integer, pgTable, serial, varchar } from "drizzle-orm/pg-core";
import { userSources } from "./userSources";

export const userSourceSettings = pgTable(
  "user_source_settings",
  {
    id: serial("id").primaryKey(),
    settings: varchar("settings").notNull(),
    userSource: integer("user_source")
      .references(() => userSources.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => [
    index("user_source_settings_user_source_idx").on(table.userSource),
  ],
);

export type UserSourceSetting = typeof userSourceSettings.$inferSelect;
export type UserSourceSettingInsert = typeof userSourceSettings.$inferInsert;

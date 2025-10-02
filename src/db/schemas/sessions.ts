import { index, integer, pgTable, serial, varchar } from "drizzle-orm/pg-core";
import { users } from "./users";

export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    sid: varchar("sid").notNull(),
    userAgent: varchar("user_agent").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("sessions_sid_idx").on(table.sid),
    index("sessions_user_id_idx").on(table.userId),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;

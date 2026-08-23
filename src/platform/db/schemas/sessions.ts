import { integer, pgTable, serial, varchar } from "drizzle-orm/pg-core";
import { users } from "#platform/db/schemas/users.ts";

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  sid: varchar("sid").notNull(),
  userAgent: varchar("user_agent").notNull(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

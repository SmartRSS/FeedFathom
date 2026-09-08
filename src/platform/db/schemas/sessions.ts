import { sql } from "drizzle-orm";
import {
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "#platform/db/schemas/users.ts";

// Absolute lifetime of a session, counted from its creation -- not sliding,
// so a stolen sid dies on the same clock a legitimate one does. The cookie
// naming the session carries the same window as its Max-Age (see
// session-header.ts), which imports this constant rather than restating it.
export const SESSION_TTL_DAYS = 365;

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  sid: varchar("sid").notNull(),
  userAgent: varchar("user_agent").notNull(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // The DDL default needs a plain SQL literal, so the interval cannot be
  // built from SESSION_TTL_DAYS here -- keep the two in step.
  expiresAt: timestamp("expires_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW() + INTERVAL '365 days'`),
});

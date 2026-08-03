import {
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

export const sources = pgTable(
  "sources",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    favicon: varchar("favicon"),
    homeUrl: varchar("home_url").notNull(),
    id: serial("id").primaryKey(),
    lastAttempt: timestamp("last_attempt"),
    lastSuccess: timestamp("last_success"),
    nextCheckAt: timestamp("next_check_at"),
    recentFailureDetails: varchar("recent_failure_details")
      .notNull()
      .default(""),
    recentFailures: integer("recent_failures").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    url: varchar("url").notNull(),
  },
  (table) => [
    index("last_attempt_idx").on(table.lastAttempt),
    index("next_check_at_idx").on(table.nextCheckAt),
    index("recent_failures_idx").on(table.recentFailures),
    unique("sources_url_unique").on(table.url),
  ],
);

type SourceRow = typeof sources.$inferSelect;
export type Source = Omit<SourceRow, "nextCheckAt"> & {
  nextCheckAt?: Date | null;
};

import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { articles } from "./articles";
import { userSources } from "./userSources";

export const sources = pgTable(
  "sources",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    favicon: varchar("favicon"),
    homeUrl: varchar("home_url").notNull(),
    id: serial("id").primaryKey(),
    lastAttempt: timestamp("last_attempt"),
    lastSuccess: timestamp("last_success"),
    recentFailureDetails: varchar("recent_failure_details")
      .notNull()
      .default(""),
    recentFailures: integer("recent_failures").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    url: varchar("url").notNull(),
  },
  (table) => [
    index("last_attempt_idx").on(table.lastAttempt),
    index("recent_failures_idx").on(table.recentFailures),
    index("sources_url_idx").on(table.url),
    index("sources_last_success_idx").on(table.lastSuccess),
    index("sources_attempt_failures_idx").on(
      table.lastAttempt,
      table.recentFailures,
    ),
  ],
);

export type Source = typeof sources.$inferSelect;
export type SourceInsert = typeof sources.$inferInsert;

export const sourceArticlesRelation = relations(sources, ({ many }) => {
  return {
    articles: many(articles),
  };
});

export const sourcesUserSourcesRelation = relations(sources, ({ many }) => {
  return {
    userSources: many(userSources),
  };
});

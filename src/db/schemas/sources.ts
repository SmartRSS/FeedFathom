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
    lastStrategyDetection: timestamp("last_strategy_detection"),
    recentFailureDetails: varchar("recent_failure_details")
      .notNull()
      .default(""),
    recentFailures: integer("recent_failures").notNull().default(0),
    sourceType: varchar("source_type").notNull().default("feed"), // 'feed', 'newsletter', 'websub'
    strategyConfig: varchar("strategy_config"), // JSON config for custom headers, etc.
    strategyType: varchar("strategy_type"), // 'generic', 'json', 'facebook', 'websub'
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    url: varchar("url").notNull(),
    webSubHub: varchar("websub_hub"),
    webSubSelf: varchar("websub_self"),
    webSubTopic: varchar("websub_topic"),
  },
  (table) => [
    index("last_attempt_idx").on(table.lastAttempt),
    index("recent_failures_idx").on(table.recentFailures),
    index("strategy_type_idx").on(table.strategyType),
    index("source_type_idx").on(table.sourceType),
    index("websub_hub_idx").on(table.webSubHub),
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

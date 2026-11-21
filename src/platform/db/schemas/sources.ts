import {
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "#platform/db/schemas/users.ts";

export const sources = pgTable(
  "sources",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    favicon: varchar("favicon"),
    faviconHash: varchar("favicon_hash").generatedAlwaysAs(sql`md5("favicon")`),
    homeUrl: varchar("home_url").notNull(),
    id: serial("id").primaryKey(),
    kind: varchar("kind", { enum: ["feed", "email", "websub"] })
      .notNull()
      .default("feed"),
    lastAttempt: timestamp("last_attempt", { withTimezone: true }),
    lastBodyHash: varchar("last_body_hash"),
    lastFetchTrigger: varchar("last_fetch_trigger", {
      enum: ["poll", "manual", "websub-push", "email"],
    }),
    lastSuccess: timestamp("last_success", { withTimezone: true }),
    notBefore: timestamp("not_before", { withTimezone: true })
      .notNull()
      .default(new Date(0)),
    recentFailureDetails: varchar("recent_failure_details")
      .notNull()
      .default(""),
    recentFailures: integer("recent_failures").notNull().default(0),
    reservedBy: integer("reserved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    url: varchar("url").notNull(),
    websubCallbackToken: varchar("websub_callback_token"),
    websubHubUrl: varchar("websub_hub_url"),
    websubLeaseExpiresAt: timestamp("websub_lease_expires_at", {
      withTimezone: true,
    }),
    websubSecret: varchar("websub_secret"),
    websubSubscribeAttemptedAt: timestamp("websub_subscribe_attempted_at", {
      withTimezone: true,
    }),
    websubStatus: varchar("websub_status", {
      enum: ["none", "pending", "verified", "failed"],
    })
      .notNull()
      .default("none"),
    websubTopicUrl: varchar("websub_topic_url"),
  },
  (table) => [
    index("kind_idx").on(table.kind),
    index("last_attempt_idx").on(table.lastAttempt),
    index("sources_not_before_idx").on(table.notBefore),
    index("recent_failures_idx").on(table.recentFailures),
    index("sources_reserved_by_idx")
      .on(table.reservedBy)
      .where(sql`${table.reservedBy} IS NOT NULL`),
    unique("sources_url_unique").on(table.url),
    unique("sources_websub_callback_token_unique").on(
      table.websubCallbackToken,
    ),
  ],
);

type SourceRow = typeof sources.$inferSelect;
export type Source = Omit<
  SourceRow,
  "faviconHash" | "lastBodyHash" | "notBefore"
> & {
  faviconHash?: null | string;
  lastBodyHash?: null | string;
  notBefore?: Date;
};
export type FetchTrigger = NonNullable<SourceRow["lastFetchTrigger"]>;
export type WebSubStatus = SourceRow["websubStatus"];

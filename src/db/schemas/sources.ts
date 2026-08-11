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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    favicon: varchar("favicon"),
    homeUrl: varchar("home_url").notNull(),
    id: serial("id").primaryKey(),
    // Explicit delivery mechanism, not inferred from the URL's shape at
    // query time: "email" sources never get an HTTP poll at all (there's
    // no endpoint to fetch), "websub" polls on a flat once-daily fallback
    // cadence regardless of recentFailures (see getSourcesToProcess) since
    // a hub push is the primary update path, and "feed" is the default
    // ordinary polling behavior. Sources move feed -> websub on
    // markWebSubVerified and back on markWebSubFailed; "email" is set once
    // at creation and never changes.
    kind: varchar("kind", { enum: ["feed", "email", "websub"] })
      .notNull()
      .default("feed"),
    lastAttempt: timestamp("last_attempt", { withTimezone: true }),
    lastSuccess: timestamp("last_success", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    recentFailureDetails: varchar("recent_failure_details")
      .notNull()
      .default(""),
    recentFailures: integer("recent_failures").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    url: varchar("url").notNull(),
    // WebSub (formerly PubSubHubbub): a hub push-notifies our callback
    // instead of us polling, once subscribed. All nullable/"none" by
    // default -- most feeds don't advertise a hub at all, so this is
    // opportunistic, not required. websubTopicUrl is the feed's own
    // canonical/self URL from its hub advertisement, which can differ
    // from `url` (redirects, feed aggregators, etc.) -- the hub requires
    // the exact topic it was told about, not just any URL that resolves
    // to the same feed.
    websubCallbackToken: varchar("websub_callback_token"),
    websubHubUrl: varchar("websub_hub_url"),
    websubLeaseExpiresAt: timestamp("websub_lease_expires_at", {
      withTimezone: true,
    }),
    websubSecret: varchar("websub_secret"),
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
    index("next_check_at_idx").on(table.nextCheckAt),
    index("recent_failures_idx").on(table.recentFailures),
    unique("sources_url_unique").on(table.url),
    unique("sources_websub_callback_token_unique").on(
      table.websubCallbackToken,
    ),
  ],
);

type SourceRow = typeof sources.$inferSelect;
export type Source = Omit<SourceRow, "nextCheckAt"> & {
  nextCheckAt?: Date | null;
};

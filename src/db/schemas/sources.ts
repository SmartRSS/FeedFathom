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
    // How the last successful fetch actually reached us -- distinct from
    // `kind`, which is the source's steady-state delivery mechanism.
    // A "websub" source still shows "poll" here on its once-daily fallback
    // fetches, and "websub-push" only on fetches actually triggered by a
    // hub POST -- useful for confirming push delivery is really happening
    // rather than the fallback poll quietly doing all the work.
    lastFetchTrigger: varchar("last_fetch_trigger", {
      enum: ["poll", "manual", "websub-push", "email"],
    }),
    lastSuccess: timestamp("last_success", { withTimezone: true }),
    // Earliest time this source is eligible for another poll -- set on
    // every successSource (from the response's Cache-Control) and every
    // failSource (from the backoff formula), so getSourcesToProcess's
    // "feed" branch just checks notBefore <= NOW() instead of separately
    // recomputing a backoff interval from recentFailures at read time.
    // Defaults to the Unix epoch (always due) rather than NULL, so it
    // never needs an `IS NULL OR` check anywhere it's queried.
    notBefore: timestamp("not_before", { withTimezone: true })
      .notNull()
      .default(new Date(0)),
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
    // Claim guard against concurrent subscribe attempts for the same source
    // -- discovery fires both immediately at subscribe time and again from
    // the enqueued initial-fetch job, and each attempt generates its own
    // fresh callback token/secret with no coordination between them. A hub
    // that tolerates a rapid duplicate subscribe won't show it, but a
    // stricter one can reject the second request outright. See
    // recordWebSubDiscovery's claim UPDATE.
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
    unique("sources_url_unique").on(table.url),
    unique("sources_websub_callback_token_unique").on(
      table.websubCallbackToken,
    ),
  ],
);

type SourceRow = typeof sources.$inferSelect;
export type Source = Omit<SourceRow, "notBefore"> & {
  notBefore?: Date;
};

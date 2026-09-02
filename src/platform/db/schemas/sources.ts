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
    // Delivery mechanism, explicit rather than inferred from the URL. Drives
    // the polling cadence in getSourcesToProcess. Sources move feed -> websub
    // on markWebSubVerified and back on markWebSubFailed; "email" is set at
    // creation and never changes.
    kind: varchar("kind", { enum: ["feed", "email", "websub"] })
      .notNull()
      .default("feed"),
    lastAttempt: timestamp("last_attempt", { withTimezone: true }),
    // How the last successful fetch arrived, unlike `kind`, which is the
    // steady-state mechanism. A "websub" source shows "poll" on its fallback
    // fetches, so this is what confirms push delivery is actually happening.
    lastFetchTrigger: varchar("last_fetch_trigger", {
      enum: ["poll", "manual", "websub-push", "email"],
    }),
    lastSuccess: timestamp("last_success", { withTimezone: true }),
    // Earliest time this source may be polled again, written by successSource
    // (from Cache-Control) and failSource (from the backoff formula), so the
    // read side is just notBefore <= NOW(). Defaults to the Unix epoch rather
    // than NULL, so no query needs an `IS NULL OR`.
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
    // WebSub: once subscribed, a hub pushes to the callback instead of being
    // polled. Nullable/"none" by default, since most feeds advertise no hub.
    // websubTopicUrl is the canonical URL from the hub advertisement, which
    // can differ from `url` -- the hub requires the exact topic it was told
    // about, not any URL resolving to the same feed.
    websubCallbackToken: varchar("websub_callback_token"),
    websubHubUrl: varchar("websub_hub_url"),
    websubLeaseExpiresAt: timestamp("websub_lease_expires_at", {
      withTimezone: true,
    }),
    websubSecret: varchar("websub_secret"),
    // Claim guard against concurrent subscribe attempts: discovery fires at
    // subscribe time and again from the initial-fetch job, each minting its
    // own token/secret. A strict hub rejects the second request outright. See
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

import {
  boolean,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    email: varchar("email").notNull().unique(),
    id: serial("id").primaryKey(),
    isAdmin: boolean("is_admin").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    name: varchar("name").notNull(),
    password: varchar("password").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: varchar("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("inactive"),
    activationToken: varchar("activation_token"),
    activationTokenExpiresAt: timestamp("activation_token_expires_at", {
      withTimezone: true,
    }),
    // The reset token is stored as a SHA-256 digest, unlike the activation
    // token beside it: this one is enough on its own to take an account over,
    // so a dump of this table must not be a set of working reset links. The
    // token is 122 random bits, which is past brute force without stretching.
    passwordResetTokenHash: varchar("password_reset_token_hash"),
    passwordResetTokenExpiresAt: timestamp("password_reset_token_expires_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    unique().on(table.activationToken),
    unique().on(table.passwordResetTokenHash),
  ],
);

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
  },
  (table) => [unique().on(table.activationToken)],
);

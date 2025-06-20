import { relations } from "drizzle-orm";
import {
  boolean,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { userArticles } from "./userArticles";
import { userSources } from "./userSources";

export const users = pgTable(
  "users",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    email: varchar("email").notNull().unique(),
    id: serial("id").primaryKey(),
    isAdmin: boolean("is_admin").notNull().default(false),
    name: varchar("name").notNull(),
    password: varchar("password").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    status: varchar("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("inactive"),
    activationToken: varchar("activation_token"),
    activationTokenExpiresAt: timestamp("activation_token_expires_at"),
  },
  (table) => [unique().on(table.activationToken)],
);

export type User = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;

export const userArticlesRelation = relations(users, ({ many }) => {
  return {
    userArticles: many(userArticles),
  };
});

export const userSourcesRelation = relations(users, ({ many }) => {
  return {
    userSources: many(userSources),
  };
});

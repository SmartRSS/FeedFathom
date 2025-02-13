import {
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  varchar,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name").notNull(),
  email: varchar("email").notNull().unique(),
  password: varchar("password").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  isAdmin: boolean("is_admin").notNull().default(false),
});

export const sources = pgTable(
  "sources",
  {
    id: serial("id").primaryKey(),
    url: varchar("url").notNull(),
    homeUrl: varchar("home_url").notNull(),
    favicon: varchar("favicon"),
    recentFailures: integer("recent_failures").notNull().default(0),
    lastAttempt: timestamp("last_attempt"),
    lastSuccess: timestamp("last_success"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    recentFailureDetails: varchar("recent_failure_details")
      .notNull()
      .default(""),
  },
  (table) => [
    index("last_attempt_idx").on(table.lastAttempt),
    index("recent_failures_idx").on(table.recentFailures),
  ],
);

export const userFolders = pgTable("user_folders", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const userSources = pgTable(
  "user_sources",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    parentId: integer("parent_id").references(() => userFolders.id, {
      onDelete: "cascade",
    }),
  },
  (table) => ({
    unique: unique().on(table.userId, table.sourceId),
  }),
);

export const userSourceSettings = pgTable("user_source_settings", {
  id: serial("id").primaryKey(),
  userSource: integer("user_source")
    .references(() => userSources.id, {
      onDelete: "cascade",
    })
    .notNull(),
  settings: varchar("settings").notNull(),
});

export const articles = pgTable("articles", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  guid: varchar("guid").notNull().unique(),
  title: varchar("title").notNull(),
  url: varchar("url").notNull(),
  content: text("content").notNull(),
  author: varchar("author").notNull(),
  publishedAt: timestamp("published_at").notNull(),
  updatedAt: timestamp("updated_at"),
  // seenAt: timestamp('seen_at')
});

export const userArticles = pgTable(
  "user_articles",
  {
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    articleId: integer("article_id")
      .references(() => articles.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      })
      .notNull(),
    readAt: timestamp("read_at"),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.articleId] }),
  }),
);

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sid: varchar("sid").notNull(),
  userAgent: varchar("user_agent").notNull(),
});

export const userArticlesRelation = relations(users, ({ many }) => ({
  userArticles: many(userArticles),
}));

export const userSourcesRelation = relations(users, ({ many }) => ({
  userSources: many(userSources),
}));

export const articleUserArticlesRelation = relations(articles, ({ many }) => ({
  userArticles: many(userArticles),
}));

export const sourceArticlesRelation = relations(sources, ({ many }) => ({
  articles: many(articles),
}));

export const articlesSourceRelation = relations(articles, ({ one }) => ({
  source: one(sources, {
    fields: [articles.sourceId],
    references: [sources.id],
  }),
}));

export const sourcesUserSourcesRelation = relations(sources, ({ many }) => ({
  userSources: many(userSources),
}));

export const userSourcesSourceRelation = relations(userSources, ({ one }) => ({
  source: one(sources, {
    fields: [userSources.sourceId],
    references: [sources.id],
  }),
}));

import { relations } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  createdAt: timestamp("created_at").notNull().defaultNow(),
  email: varchar("email").notNull().unique(),
  id: serial("id").primaryKey(),
  isAdmin: boolean("is_admin").notNull().default(false),
  name: varchar("name").notNull(),
  password: varchar("password").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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
  (table) => {
    return [
      index("last_attempt_idx").on(table.lastAttempt),
      index("recent_failures_idx").on(table.recentFailures),
    ];
  },
);

export const userFolders = pgTable("user_folders", {
  createdAt: timestamp("created_at").notNull().defaultNow(),
  id: serial("id").primaryKey(),
  name: varchar("name").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  userId: integer("user_id")
    .notNull()
    .references(
      () => {
        return users.id;
      },
      { onDelete: "cascade" },
    ),
});

export const userSources = pgTable(
  "user_sources",
  {
    id: serial("id").primaryKey(),
    name: varchar("name").notNull(),
    parentId: integer("parent_id").references(
      () => {
        return userFolders.id;
      },
      {
        onDelete: "cascade",
      },
    ),
    sourceId: integer("source_id")
      .notNull()
      .references(
        () => {
          return sources.id;
        },
        { onDelete: "cascade" },
      ),
    userId: integer("user_id")
      .notNull()
      .references(
        () => {
          return users.id;
        },
        { onDelete: "cascade" },
      ),
  },
  (table) => {
    return [unique().on(table.userId, table.sourceId)];
  },
);

export const userSourceSettings = pgTable("user_source_settings", {
  id: serial("id").primaryKey(),
  settings: varchar("settings").notNull(),
  userSource: integer("user_source")
    .references(
      () => {
        return userSources.id;
      },
      {
        onDelete: "cascade",
      },
    )
    .notNull(),
});

export const articles = pgTable("articles", {
  author: varchar("author").notNull(),
  content: text("content").notNull(),
  guid: varchar("guid").notNull().unique(),
  id: serial("id").primaryKey(),
  publishedAt: timestamp("published_at").notNull(),
  sourceId: integer("source_id")
    .notNull()
    .references(
      () => {
        return sources.id;
      },
      { onDelete: "cascade" },
    ),
  title: varchar("title").notNull(),
  updatedAt: timestamp("updated_at"),
  url: varchar("url").notNull(),
  // seenAt: timestamp('seen_at')
});

export const userArticles = pgTable(
  "user_articles",
  {
    articleId: integer("article_id")
      .references(
        () => {
          return articles.id;
        },
        {
          onDelete: "cascade",
          onUpdate: "cascade",
        },
      )
      .notNull(),
    deletedAt: timestamp("deleted_at"),
    readAt: timestamp("read_at"),
    userId: integer("user_id")
      .references(
        () => {
          return users.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.articleId] })];
  },
);

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  sid: varchar("sid").notNull(),
  userAgent: varchar("user_agent").notNull(),
  userId: integer("user_id")
    .notNull()
    .references(
      () => {
        return users.id;
      },
      { onDelete: "cascade" },
    ),
});

export const jobQueue = pgTable(
  "job_queue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    generalId: varchar("general_id").notNull(),
    name: varchar("name").notNull(),
    notBefore: timestamp("not_before").notNull().defaultNow(),
    payload: jsonb("payload").notNull().default({}),
  },
  (table) => {
    return [
      index("general_id_idx").on(table.generalId),
      index("not_before_idx").on(table.notBefore),
    ];
  },
);

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

export const articleUserArticlesRelation = relations(articles, ({ many }) => {
  return {
    userArticles: many(userArticles),
  };
});

export const sourceArticlesRelation = relations(sources, ({ many }) => {
  return {
    articles: many(articles),
  };
});

export const articlesSourceRelation = relations(articles, ({ one }) => {
  return {
    source: one(sources, {
      fields: [articles.sourceId],
      references: [sources.id],
    }),
  };
});

export const sourcesUserSourcesRelation = relations(sources, ({ many }) => {
  return {
    userSources: many(userSources),
  };
});

export const userSourcesSourceRelation = relations(userSources, ({ one }) => {
  return {
    source: one(sources, {
      fields: [userSources.sourceId],
      references: [sources.id],
    }),
  };
});

import {
  bigserial,
  index,
  jsonb,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const jobQueue = pgTable(
  "job_queue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    generalId: varchar("general_id").notNull().unique(),
    name: varchar("name").notNull(),
    notBefore: timestamp("not_before").notNull().defaultNow(),
    payload: jsonb("payload").notNull().default({}),
    lockedAt: timestamp("locked_at"),
  },
  (table) => [
    index("general_id_idx").on(table.generalId),
    index("not_before_idx").on(table.notBefore),
    index("locked_at_idx").on(table.lockedAt),
  ],
);

export type Job = typeof jobQueue.$inferSelect;
export type JobInsert = typeof jobQueue.$inferInsert;

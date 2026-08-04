import { pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const jobFailures = pgTable("job_failures", {
  id: serial("id").primaryKey(),
  jobType: varchar("job_type").notNull(),
  errorMessage: text("error_message").notNull(),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
});

ALTER TABLE "sources" ADD COLUMN "not_before" timestamp with time zone DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
CREATE INDEX "sources_not_before_idx" ON "sources" USING btree ("not_before");--> statement-breakpoint
-- Preserve existing schedules instead of resetting every source to
-- immediately-due: carry over next_check_at where set, otherwise fall back
-- to the recentFailures-based backoff getSourcesToProcess used to compute
-- at read time (matches failSource's new write-time formula exactly).
UPDATE "sources"
SET "not_before" = COALESCE(
  "next_check_at",
  "last_attempt" + INTERVAL '5 minutes' * LEAST("recent_failures", 15),
  '1970-01-01T00:00:00.000Z'
);
ALTER TABLE "job_queue" ADD COLUMN "locked_at" timestamp;--> statement-breakpoint
CREATE INDEX "locked_at_idx" ON "job_queue" USING btree ("locked_at");
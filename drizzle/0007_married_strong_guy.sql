CREATE INDEX "last_attempt_idx" ON "sources" USING btree ("last_attempt");--> statement-breakpoint
CREATE INDEX "recent_failures_idx" ON "sources" USING btree ("recent_failures");
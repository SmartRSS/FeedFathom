CREATE UNIQUE INDEX "sessions_sid_unique" ON "sessions" USING btree ("sid");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");
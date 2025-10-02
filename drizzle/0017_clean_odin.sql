CREATE INDEX "sessions_sid_idx" ON "sessions" USING btree ("sid");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_source_settings_user_source_idx" ON "user_source_settings" USING btree ("user_source");
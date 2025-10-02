CREATE INDEX "articles_source_published_idx" ON "articles" USING btree ("source_id","published_at");--> statement-breakpoint
CREATE INDEX "articles_updated_at_idx" ON "articles" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "articles_source_last_seen_idx" ON "articles" USING btree ("source_id","last_seen_in_feed_at");--> statement-breakpoint
CREATE INDEX "sources_url_idx" ON "sources" USING btree ("url");--> statement-breakpoint
CREATE INDEX "sources_last_success_idx" ON "sources" USING btree ("last_success");--> statement-breakpoint
CREATE INDEX "sources_attempt_failures_idx" ON "sources" USING btree ("last_attempt","recent_failures");--> statement-breakpoint
CREATE INDEX "user_articles_user_id_idx" ON "user_articles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_articles_article_id_idx" ON "user_articles" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "user_articles_user_read_idx" ON "user_articles" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "user_articles_user_article_idx" ON "user_articles" USING btree ("user_id","article_id");--> statement-breakpoint
CREATE INDEX "user_folders_user_id_idx" ON "user_folders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sources_user_id_idx" ON "user_sources" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sources_source_id_idx" ON "user_sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "user_sources_user_source_idx" ON "user_sources" USING btree ("user_id","source_id");--> statement-breakpoint
CREATE INDEX "user_sources_parent_id_idx" ON "user_sources" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "user_sources_created_at_idx" ON "user_sources" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_sources_user_created_idx" ON "user_sources" USING btree ("user_id","created_at");
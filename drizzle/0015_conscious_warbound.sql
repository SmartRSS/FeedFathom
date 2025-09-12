CREATE INDEX "articles_source_published_idx" ON "articles" USING btree ("source_id","published_at");--> statement-breakpoint
CREATE INDEX "articles_updated_at_idx" ON "articles" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "user_articles_user_id_idx" ON "user_articles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_articles_article_id_idx" ON "user_articles" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "user_articles_user_read_idx" ON "user_articles" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "user_sources_user_id_idx" ON "user_sources" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sources_source_id_idx" ON "user_sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "user_sources_user_source_idx" ON "user_sources" USING btree ("user_id","source_id");
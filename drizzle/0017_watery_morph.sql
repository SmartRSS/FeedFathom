ALTER TABLE "articles" ADD COLUMN "sanitized_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "favicon_hash" varchar GENERATED ALWAYS AS (md5("favicon")) STORED;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_body_hash" varchar;--> statement-breakpoint
CREATE INDEX "articles_published_id_idx" ON "articles" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_articles_source_id_idx" ON "user_articles" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "user_articles_covering_idx" ON "user_articles" USING btree ("user_id","source_id","guid","read_at","deleted_at");--> statement-breakpoint
CREATE INDEX "user_articles_deleted_idx" ON "user_articles" USING btree ("user_id","source_id","guid") WHERE "user_articles"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_folders_user_id_name_idx" ON "user_folders" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "user_sources_parent_id_idx" ON "user_sources" USING btree ("parent_id") WHERE "user_sources"."parent_id" IS NOT NULL;
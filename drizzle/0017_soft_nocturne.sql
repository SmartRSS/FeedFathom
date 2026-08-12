CREATE INDEX IF NOT EXISTS "articles_source_last_seen_idx" ON "articles" USING btree ("source_id","last_seen_in_feed_at");

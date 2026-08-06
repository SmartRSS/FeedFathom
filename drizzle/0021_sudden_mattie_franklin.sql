DROP INDEX IF EXISTS "user_articles_article_id_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_articles_article_user_idx" ON "user_articles" USING btree ("article_id","user_id");
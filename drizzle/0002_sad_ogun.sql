ALTER TABLE "user_articles" DROP CONSTRAINT "user_articles_article_id_articles_id_fk";
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "seen_at" timestamp;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_articles" ADD CONSTRAINT "user_articles_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

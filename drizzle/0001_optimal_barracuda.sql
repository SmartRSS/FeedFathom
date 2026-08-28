-- Every upsert attempt consumes a sequence value whether it inserts or
-- conflicts, so this counter climbs by millions a day for a table of
-- thousands of rows. The 32-bit serial was months from its ceiling.
ALTER TABLE "articles" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER SEQUENCE "articles_id_seq" AS bigint;--> statement-breakpoint
-- Re-key removals on the article's natural identity, (source, guid), and
-- drop the foreign key to articles entirely. Pruning an article used to
-- cascade every user's record of having removed it away with the row, so
-- the next fetch listing that guid again brought it back unread under a
-- fresh id. The removal now outlives the article.
ALTER TABLE "user_articles" DROP CONSTRAINT "user_articles_article_id_articles_id_fk";--> statement-breakpoint
ALTER TABLE "user_articles" ADD COLUMN "guid" varchar;--> statement-breakpoint
ALTER TABLE "user_articles" ADD COLUMN "source_id" integer;--> statement-breakpoint
UPDATE "user_articles" AS "ua"
  SET "guid" = "a"."guid", "source_id" = "a"."source_id"
  FROM "articles" AS "a"
  WHERE "a"."id" = "ua"."article_id";--> statement-breakpoint
-- The foreign key just dropped guaranteed every row found a match above, so
-- this deletes nothing. It is here so that a row which somehow missed one
-- cannot fail the NOT NULL below and abort the deploy: such a row already
-- pointed at no article and meant nothing.
DELETE FROM "user_articles" WHERE "guid" IS NULL OR "source_id" IS NULL;--> statement-breakpoint
ALTER TABLE "user_articles" ALTER COLUMN "guid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_articles" ALTER COLUMN "source_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "user_articles_user_id_idx";--> statement-breakpoint
DROP INDEX "user_articles_article_user_idx";--> statement-breakpoint
DROP INDEX "user_articles_user_read_idx";--> statement-breakpoint
ALTER TABLE "user_articles" DROP CONSTRAINT "user_articles_user_id_article_id_pk";--> statement-breakpoint
ALTER TABLE "user_articles" DROP COLUMN "article_id";--> statement-breakpoint
ALTER TABLE "user_articles" ADD CONSTRAINT "user_articles_user_id_source_id_guid_pk" PRIMARY KEY("user_id","source_id","guid");--> statement-breakpoint
ALTER TABLE "user_articles" ADD CONSTRAINT "user_articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;

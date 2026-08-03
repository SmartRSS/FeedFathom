ALTER TABLE "articles" DROP CONSTRAINT "articles_guid_unique";--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_id_guid_unique" UNIQUE("source_id","guid");--> statement-breakpoint
LOCK TABLE
  "sources",
  "articles",
  "user_sources",
  "user_source_settings",
  "user_articles"
IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
CREATE TEMP TABLE "_source_merge"
ON COMMIT DROP
AS
SELECT
  "id" AS "old_id",
  MIN("id") OVER (PARTITION BY "url") AS "canonical_id"
FROM (
  SELECT
    "id",
    "url",
    COUNT(*) OVER (PARTITION BY "url") AS "url_count"
  FROM "sources"
) AS "duplicate_candidates"
WHERE "url_count" > 1;--> statement-breakpoint
ALTER TABLE "_source_merge" ADD PRIMARY KEY ("old_id");--> statement-breakpoint
WITH "source_state" AS (
  SELECT
    "mapping"."canonical_id",
    MIN("source"."created_at") AS "created_at",
    MAX("source"."updated_at") AS "updated_at",
    MAX("source"."last_attempt") AS "last_attempt",
    MAX("source"."last_success") AS "last_success",
    COALESCE(
      (
        ARRAY_AGG(
          NULLIF("source"."home_url", '')
          ORDER BY
            ("source"."id" = "mapping"."canonical_id") DESC,
            "source"."updated_at" DESC,
            "source"."id"
        ) FILTER (WHERE NULLIF("source"."home_url", '') IS NOT NULL)
      )[1],
      ''
    ) AS "home_url",
    (
      ARRAY_AGG(
        NULLIF("source"."favicon", '')
        ORDER BY
          ("source"."id" = "mapping"."canonical_id") DESC,
          "source"."updated_at" DESC,
          "source"."id"
      ) FILTER (WHERE NULLIF("source"."favicon", '') IS NOT NULL)
    )[1] AS "favicon",
    (
      ARRAY_AGG(
        "source"."recent_failures"
        ORDER BY
          "source"."last_attempt" DESC NULLS LAST,
          ("source"."id" = "mapping"."canonical_id") DESC,
          "source"."id"
      )
    )[1] AS "recent_failures",
    (
      ARRAY_AGG(
        "source"."recent_failure_details"
        ORDER BY
          "source"."last_attempt" DESC NULLS LAST,
          ("source"."id" = "mapping"."canonical_id") DESC,
          "source"."id"
      )
    )[1] AS "recent_failure_details"
  FROM "_source_merge" AS "mapping"
  INNER JOIN "sources" AS "source"
    ON "source"."id" = "mapping"."old_id"
  GROUP BY "mapping"."canonical_id"
)
UPDATE "sources" AS "canonical"
SET
  "created_at" = "state"."created_at",
  "updated_at" = "state"."updated_at",
  "last_attempt" = "state"."last_attempt",
  "last_success" = "state"."last_success",
  "home_url" = "state"."home_url",
  "favicon" = "state"."favicon",
  "recent_failures" = "state"."recent_failures",
  "recent_failure_details" = "state"."recent_failure_details"
FROM "source_state" AS "state"
WHERE "canonical"."id" = "state"."canonical_id";--> statement-breakpoint
CREATE TEMP TABLE "_user_source_merge"
ON COMMIT DROP
AS
SELECT
  "subscription"."id" AS "old_id",
  MIN("subscription"."id") OVER (
    PARTITION BY "subscription"."user_id", "mapping"."canonical_id"
  ) AS "keep_id",
  MIN("subscription"."created_at") OVER (
    PARTITION BY "subscription"."user_id", "mapping"."canonical_id"
  ) AS "created_at",
  "mapping"."canonical_id"
FROM "user_sources" AS "subscription"
INNER JOIN "_source_merge" AS "mapping"
  ON "mapping"."old_id" = "subscription"."source_id";--> statement-breakpoint
ALTER TABLE "_user_source_merge" ADD PRIMARY KEY ("old_id");--> statement-breakpoint
UPDATE "user_source_settings" AS "settings"
SET "user_source" = "mapping"."keep_id"
FROM "_user_source_merge" AS "mapping"
WHERE "settings"."user_source" = "mapping"."old_id"
  AND "mapping"."old_id" <> "mapping"."keep_id";--> statement-breakpoint
UPDATE "user_sources" AS "kept"
SET "created_at" = "state"."created_at"
FROM (
  SELECT "keep_id", MIN("created_at") AS "created_at"
  FROM "_user_source_merge"
  GROUP BY "keep_id"
) AS "state"
WHERE "kept"."id" = "state"."keep_id";--> statement-breakpoint
DELETE FROM "user_sources" AS "duplicate"
USING "_user_source_merge" AS "mapping"
WHERE "duplicate"."id" = "mapping"."old_id"
  AND "mapping"."old_id" <> "mapping"."keep_id";--> statement-breakpoint
UPDATE "user_sources" AS "subscription"
SET "source_id" = "mapping"."canonical_id"
FROM "_user_source_merge" AS "mapping"
WHERE "subscription"."id" = "mapping"."keep_id"
  AND "subscription"."source_id" <> "mapping"."canonical_id";--> statement-breakpoint
CREATE TEMP TABLE "_article_merge"
ON COMMIT DROP
AS
SELECT
  "article"."id" AS "old_id",
  MIN("article"."id") OVER (
    PARTITION BY "mapping"."canonical_id", "article"."guid"
  ) AS "keep_id",
  "mapping"."canonical_id"
FROM "articles" AS "article"
INNER JOIN "_source_merge" AS "mapping"
  ON "mapping"."old_id" = "article"."source_id";--> statement-breakpoint
ALTER TABLE "_article_merge" ADD PRIMARY KEY ("old_id");--> statement-breakpoint
CREATE TEMP TABLE "_user_article_merge"
ON COMMIT DROP
AS
SELECT
  "state"."user_id",
  "mapping"."keep_id" AS "article_id",
  MAX("state"."read_at") AS "read_at",
  MAX("state"."deleted_at") AS "deleted_at"
FROM "user_articles" AS "state"
INNER JOIN "_article_merge" AS "mapping"
  ON "mapping"."old_id" = "state"."article_id"
GROUP BY "state"."user_id", "mapping"."keep_id";--> statement-breakpoint
WITH "article_state" AS (
  SELECT
    "mapping"."keep_id",
    MAX("article"."last_seen_in_feed_at") AS "last_seen_in_feed_at"
  FROM "_article_merge" AS "mapping"
  INNER JOIN "articles" AS "article"
    ON "article"."id" = "mapping"."old_id"
  GROUP BY "mapping"."keep_id"
)
UPDATE "articles" AS "kept"
SET "last_seen_in_feed_at" = "state"."last_seen_in_feed_at"
FROM "article_state" AS "state"
WHERE "kept"."id" = "state"."keep_id";--> statement-breakpoint
DELETE FROM "user_articles" AS "state"
USING "_article_merge" AS "mapping"
WHERE "state"."article_id" = "mapping"."old_id";--> statement-breakpoint
INSERT INTO "user_articles" (
  "user_id",
  "article_id",
  "read_at",
  "deleted_at"
)
SELECT
  "user_id",
  "article_id",
  "read_at",
  "deleted_at"
FROM "_user_article_merge";--> statement-breakpoint
DELETE FROM "articles" AS "duplicate"
USING "_article_merge" AS "mapping"
WHERE "duplicate"."id" = "mapping"."old_id"
  AND "mapping"."old_id" <> "mapping"."keep_id";--> statement-breakpoint
UPDATE "articles" AS "article"
SET "source_id" = "mapping"."canonical_id"
FROM "_article_merge" AS "mapping"
WHERE "article"."id" = "mapping"."keep_id"
  AND "article"."source_id" <> "mapping"."canonical_id";--> statement-breakpoint
DELETE FROM "sources" AS "duplicate"
USING "_source_merge" AS "mapping"
WHERE "duplicate"."id" = "mapping"."old_id"
  AND "mapping"."old_id" <> "mapping"."canonical_id";--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_url_unique" UNIQUE("url");--> statement-breakpoint
UPDATE "users"
SET "status" = 'active'
WHERE "status" = 'inactive'
  AND "activation_token" IS NULL;--> statement-breakpoint
UPDATE "articles"
SET "url" = ''
WHERE "url" <> ''
  AND "url" !~* '^https?://'
  AND "url" NOT LIKE '/article/%';--> statement-breakpoint
ALTER TABLE "articles"
ADD CONSTRAINT "articles_url_safe"
CHECK (
  "url" = ''
  OR "url" ~* '^https?://'
  OR "url" LIKE '/article/%'
);--> statement-breakpoint
ALTER TABLE "user_sources" ADD COLUMN "initialized_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_sources" ADD COLUMN "initialization_owner" varchar;--> statement-breakpoint
ALTER TABLE "user_sources" ADD COLUMN "initialization_snapshot" text;--> statement-breakpoint
ALTER TABLE "user_sources" ADD COLUMN "initializing_at" timestamp;--> statement-breakpoint
UPDATE "user_sources" SET "initialized_at" = NOW();--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "next_check_at" timestamp;--> statement-breakpoint
CREATE INDEX "next_check_at_idx" ON "sources" USING btree ("next_check_at");--> statement-breakpoint
CREATE TABLE "opml_imports" (
  "user_id" integer NOT NULL,
  "content_hash" varchar(64) NOT NULL,
  "created_at" timestamp DEFAULT NOW() NOT NULL,
  CONSTRAINT "opml_imports_user_id_content_hash_pk" PRIMARY KEY("user_id", "content_hash"),
  CONSTRAINT "opml_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
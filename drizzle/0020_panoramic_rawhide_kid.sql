ALTER TABLE "articles" ALTER COLUMN "published_at" SET DATA TYPE timestamp with time zone USING "published_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "last_seen_in_feed_at" SET DATA TYPE timestamp with time zone USING "last_seen_in_feed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "last_seen_in_feed_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "opml_imports" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "opml_imports" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "last_attempt" SET DATA TYPE timestamp with time zone USING "last_attempt" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "last_success" SET DATA TYPE timestamp with time zone USING "last_success" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "next_check_at" SET DATA TYPE timestamp with time zone USING "next_check_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "user_articles" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp with time zone USING "deleted_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user_articles" ALTER COLUMN "read_at" SET DATA TYPE timestamp with time zone USING "read_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user_folders" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user_folders" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "user_folders" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user_folders" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "user_sources" ALTER COLUMN "initialized_at" SET DATA TYPE timestamp with time zone USING "initialized_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user_sources" ALTER COLUMN "initializing_at" SET DATA TYPE timestamp with time zone USING "initializing_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user_sources" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user_sources" ALTER COLUMN "created_at" SET DEFAULT '1970-01-01 00:00:00+00'::timestamptz;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "activation_token_expires_at" SET DATA TYPE timestamp with time zone USING "activation_token_expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "job_failures" ALTER COLUMN "occurred_at" SET DATA TYPE timestamp with time zone USING "occurred_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "job_failures" ALTER COLUMN "occurred_at" SET DEFAULT now();
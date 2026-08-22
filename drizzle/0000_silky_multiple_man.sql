CREATE TABLE "articles" (
	"author" varchar NOT NULL,
	"content" text NOT NULL,
	"guid" varchar NOT NULL,
	"id" serial PRIMARY KEY NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"source_id" integer NOT NULL,
	"title" varchar NOT NULL,
	"updated_at" timestamp with time zone,
	"url" varchar NOT NULL,
	"last_seen_in_feed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "articles_source_id_guid_unique" UNIQUE("source_id","guid"),
	CONSTRAINT "articles_url_safe" CHECK ("articles"."url" = '' OR "articles"."url" ~* '^https?://' OR "articles"."url" LIKE '/article/%')
);
--> statement-breakpoint
CREATE TABLE "job_failures" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_type" varchar NOT NULL,
	"error_message" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opml_imports" (
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" integer NOT NULL,
	CONSTRAINT "opml_imports_user_id_content_hash_pk" PRIMARY KEY("user_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"sid" varchar NOT NULL,
	"user_agent" varchar NOT NULL,
	"user_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"favicon" varchar,
	"home_url" varchar NOT NULL,
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar DEFAULT 'feed' NOT NULL,
	"last_attempt" timestamp with time zone,
	"last_fetch_trigger" varchar,
	"last_success" timestamp with time zone,
	"not_before" timestamp with time zone DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	"recent_failure_details" varchar DEFAULT '' NOT NULL,
	"recent_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url" varchar NOT NULL,
	"websub_callback_token" varchar,
	"websub_hub_url" varchar,
	"websub_lease_expires_at" timestamp with time zone,
	"websub_secret" varchar,
	"websub_subscribe_attempted_at" timestamp with time zone,
	"websub_status" varchar DEFAULT 'none' NOT NULL,
	"websub_topic_url" varchar,
	CONSTRAINT "sources_url_unique" UNIQUE("url"),
	CONSTRAINT "sources_websub_callback_token_unique" UNIQUE("websub_callback_token")
);
--> statement-breakpoint
CREATE TABLE "user_articles" (
	"article_id" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"user_id" integer NOT NULL,
	CONSTRAINT "user_articles_user_id_article_id_pk" PRIMARY KEY("user_id","article_id")
);
--> statement-breakpoint
CREATE TABLE "user_folders" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_source_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"settings" varchar NOT NULL,
	"user_source" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"initialized_at" timestamp with time zone,
	"initialization_owner" varchar,
	"initialization_snapshot" text,
	"initializing_at" timestamp with time zone,
	"name" varchar NOT NULL,
	"parent_id" integer,
	"source_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT '1970-01-01 00:00:00+00'::timestamptz NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_sources_user_id_source_id_unique" UNIQUE("user_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" varchar NOT NULL,
	"id" serial PRIMARY KEY NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" varchar NOT NULL,
	"password" varchar NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar DEFAULT 'inactive' NOT NULL,
	"activation_token" varchar,
	"activation_token_expires_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_activation_token_unique" UNIQUE("activation_token")
);
--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opml_imports" ADD CONSTRAINT "opml_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_articles" ADD CONSTRAINT "user_articles_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_articles" ADD CONSTRAINT "user_articles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_folders" ADD CONSTRAINT "user_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_source_settings" ADD CONSTRAINT "user_source_settings_user_source_user_sources_id_fk" FOREIGN KEY ("user_source") REFERENCES "public"."user_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sources" ADD CONSTRAINT "user_sources_parent_id_user_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."user_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sources" ADD CONSTRAINT "user_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sources" ADD CONSTRAINT "user_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "last_seen_in_feed_at_idx" ON "articles" USING btree ("last_seen_in_feed_at");--> statement-breakpoint
CREATE INDEX "articles_source_published_idx" ON "articles" USING btree ("source_id","published_at");--> statement-breakpoint
CREATE INDEX "articles_source_last_seen_idx" ON "articles" USING btree ("source_id","last_seen_in_feed_at");--> statement-breakpoint
CREATE INDEX "articles_updated_at_idx" ON "articles" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "kind_idx" ON "sources" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "last_attempt_idx" ON "sources" USING btree ("last_attempt");--> statement-breakpoint
CREATE INDEX "sources_not_before_idx" ON "sources" USING btree ("not_before");--> statement-breakpoint
CREATE INDEX "recent_failures_idx" ON "sources" USING btree ("recent_failures");--> statement-breakpoint
CREATE INDEX "user_articles_user_id_idx" ON "user_articles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_articles_article_user_idx" ON "user_articles" USING btree ("article_id","user_id");--> statement-breakpoint
CREATE INDEX "user_articles_user_read_idx" ON "user_articles" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "user_sources_user_id_idx" ON "user_sources" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sources_source_id_idx" ON "user_sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "user_sources_user_source_idx" ON "user_sources" USING btree ("user_id","source_id");
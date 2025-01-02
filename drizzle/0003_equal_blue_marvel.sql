CREATE TABLE IF NOT EXISTS "user_source_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_source" integer,
	"settings" varchar NOT NULL
);
--> statement-breakpoint
ALTER TABLE "articles" DROP CONSTRAINT "articles_source_id_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_articles" DROP CONSTRAINT "user_articles_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_folders" DROP CONSTRAINT "user_folders_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_sources" DROP CONSTRAINT "user_sources_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_sources" DROP CONSTRAINT "user_sources_source_id_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "user_sources" DROP CONSTRAINT "user_sources_parent_id_user_folders_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_source_settings" ADD CONSTRAINT "user_source_settings_user_source_user_sources_id_fk" FOREIGN KEY ("user_source") REFERENCES "public"."user_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "articles" ADD CONSTRAINT "articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_articles" ADD CONSTRAINT "user_articles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_folders" ADD CONSTRAINT "user_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_sources" ADD CONSTRAINT "user_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_sources" ADD CONSTRAINT "user_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_sources" ADD CONSTRAINT "user_sources_parent_id_user_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."user_folders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "articles" DROP COLUMN IF EXISTS "seen_at";
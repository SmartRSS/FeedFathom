ALTER TABLE "user_source_settings" ALTER COLUMN "settings" SET DATA TYPE varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;
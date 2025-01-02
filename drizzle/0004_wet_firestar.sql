ALTER TABLE "articles" ALTER COLUMN "content" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "user_source_settings" ALTER COLUMN "user_source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");

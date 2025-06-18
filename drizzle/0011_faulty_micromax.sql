ALTER TABLE "users" ADD COLUMN "status" varchar DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "activation_token" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "activation_token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_activation_token_unique" UNIQUE("activation_token");
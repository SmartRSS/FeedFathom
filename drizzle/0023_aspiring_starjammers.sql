ALTER TABLE "sources" ADD COLUMN "websub_callback_token" varchar;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "websub_hub_url" varchar;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "websub_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "websub_secret" varchar;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "websub_status" varchar DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "websub_topic_url" varchar;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_websub_callback_token_unique" UNIQUE("websub_callback_token");
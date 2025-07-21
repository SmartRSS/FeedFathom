ALTER TABLE "sources" ADD COLUMN "websub_hub" varchar;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "websub_self" varchar;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "websub_topic" varchar;--> statement-breakpoint
CREATE INDEX "websub_hub_idx" ON "sources" USING btree ("websub_hub");
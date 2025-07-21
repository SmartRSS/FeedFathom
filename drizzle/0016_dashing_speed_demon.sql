ALTER TABLE "sources" ADD COLUMN "last_strategy_detection" timestamp;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "source_type" varchar DEFAULT 'feed' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "strategy_config" varchar;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "strategy_type" varchar;--> statement-breakpoint
CREATE INDEX "strategy_type_idx" ON "sources" USING btree ("strategy_type");--> statement-breakpoint
CREATE INDEX "source_type_idx" ON "sources" USING btree ("source_type");
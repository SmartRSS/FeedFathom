ALTER TABLE "sources" ADD COLUMN "kind" varchar DEFAULT 'feed' NOT NULL;--> statement-breakpoint
CREATE INDEX "kind_idx" ON "sources" USING btree ("kind");
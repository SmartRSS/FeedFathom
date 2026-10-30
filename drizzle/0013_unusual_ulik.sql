ALTER TABLE "sources" ADD COLUMN "reserved_by" integer;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_reserved_by_users_id_fk" FOREIGN KEY ("reserved_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sources_reserved_by_idx" ON "sources" USING btree ("reserved_by") WHERE "sources"."reserved_by" IS NOT NULL;--> statement-breakpoint
-- An email source from before ownership belongs to its earliest subscriber.
-- Its other subscribers keep their subscription (see addSourceToUser).
UPDATE "sources" SET "reserved_by" = (
  SELECT "user_id" FROM "user_sources"
  WHERE "user_sources"."source_id" = "sources"."id"
  ORDER BY "user_sources"."created_at", "user_sources"."id"
  LIMIT 1
) WHERE "kind" = 'email';

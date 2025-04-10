CREATE TABLE "job_queue" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS (identity) STORED NOT NULL,
	"general_id" varchar NOT NULL,
	"name" varchar NOT NULL,
	"not_before" timestamp DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "general_id_idx" ON "job_queue" USING btree ("general_id");--> statement-breakpoint
CREATE INDEX "not_before_idx" ON "job_queue" USING btree ("not_before");
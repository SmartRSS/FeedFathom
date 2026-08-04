CREATE TABLE "job_failures" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_type" varchar NOT NULL,
	"error_message" text NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);

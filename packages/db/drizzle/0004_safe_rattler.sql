ALTER TABLE "dataset_versions" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD COLUMN "reviewed_by" varchar(120);--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD COLUMN "review_notes" text;
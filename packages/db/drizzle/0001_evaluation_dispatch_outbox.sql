CREATE TABLE "evaluation_run_dispatches" (
	"evaluation_run_id" uuid PRIMARY KEY NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"last_error_code" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_dispatches_status_valid" CHECK ("evaluation_run_dispatches"."status" in ('pending', 'dispatching', 'dispatched')),
	CONSTRAINT "evaluation_dispatches_attempts_nonnegative" CHECK ("evaluation_run_dispatches"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "evaluation_run_dispatches" ADD CONSTRAINT "evaluation_run_dispatches_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluation_dispatches_pending_idx" ON "evaluation_run_dispatches" USING btree ("status","next_attempt_at","created_at");

CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'service', 'system');--> statement-breakpoint
CREATE TYPE "public"."dataset_source" AS ENUM('manual', 'ai_generated', 'imported', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."diagnosis_run_status" AS ENUM('running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('draft', 'queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."generation_output_status" AS ENUM('pending', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."score_kind" AS ENUM('dimension', 'overall', 'rule');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" varchar(255),
	"action" varchar(160) NOT NULL,
	"entity_type" varchar(120) NOT NULL,
	"entity_id" uuid,
	"request_id" varchar(160),
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "version_status" DEFAULT 'draft' NOT NULL,
	"source" "dataset_source" DEFAULT 'manual' NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"case_count" integer DEFAULT 0 NOT NULL,
	"generation_provenance" jsonb,
	"parent_version_id" uuid,
	"change_summary" text,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "dataset_versions_version_positive" CHECK ("dataset_versions"."version" > 0),
	CONSTRAINT "dataset_versions_case_count_nonnegative" CHECK ("dataset_versions"."case_count" >= 0),
	CONSTRAINT "dataset_versions_hash_format" CHECK ("dataset_versions"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnosis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"bundle_id" varchar(256) NOT NULL,
	"input_bundle" jsonb NOT NULL,
	"input_bundle_hash" varchar(64),
	"report_id" varchar(256),
	"report" jsonb,
	"status" "diagnosis_run_status" DEFAULT 'running' NOT NULL,
	"failure_code" varchar(120),
	"failure_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnosis_runs_hash_format" CHECK ("diagnosis_runs"."input_bundle_hash" is null or "diagnosis_runs"."input_bundle_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "diagnosis_runs_terminal_shape" CHECK ((
        "diagnosis_runs"."status" = 'running'
        and "diagnosis_runs"."completed_at" is null
        and "diagnosis_runs"."report" is null
        and "diagnosis_runs"."report_id" is null
      ) or (
        "diagnosis_runs"."status" = 'succeeded'
        and "diagnosis_runs"."completed_at" is not null
        and "diagnosis_runs"."report" is not null
        and "diagnosis_runs"."report_id" is not null
        and "diagnosis_runs"."input_bundle_hash" is not null
        and "diagnosis_runs"."failure_code" is null
        and "diagnosis_runs"."failure_message" is null
      ) or (
        "diagnosis_runs"."status" in ('failed', 'cancelled')
        and "diagnosis_runs"."completed_at" is not null
        and "diagnosis_runs"."report" is null
        and "diagnosis_runs"."report_id" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "evaluation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_version_id" uuid NOT NULL,
	"case_key" varchar(120) NOT NULL,
	"name" varchar(240),
	"input" jsonb NOT NULL,
	"expected_output" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_cases_sort_order_nonnegative" CHECK ("evaluation_cases"."sort_order" >= 0),
	CONSTRAINT "evaluation_cases_hash_format" CHECK ("evaluation_cases"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "evaluation_framework_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"framework_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "version_status" DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"parent_version_id" uuid,
	"change_summary" text,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "framework_versions_version_positive" CHECK ("evaluation_framework_versions"."version" > 0),
	CONSTRAINT "framework_versions_hash_format" CHECK ("evaluation_framework_versions"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "evaluation_frameworks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"generation_run_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"evaluator_key" varchar(120) NOT NULL,
	"evaluator_version" varchar(120) NOT NULL,
	"evaluator_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evaluator_config_hash" varchar(64) NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"requested_count" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"failure_code" varchar(120),
	"failure_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_runs_counts_nonnegative" CHECK (
      "evaluation_runs"."requested_count" >= 0 and "evaluation_runs"."succeeded_count" >= 0 and "evaluation_runs"."failed_count" >= 0
    ),
	CONSTRAINT "evaluation_runs_config_hash_format" CHECK ("evaluation_runs"."evaluator_config_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "experiment_prompt_versions" (
	"experiment_id" uuid NOT NULL,
	"prompt_version_id" uuid NOT NULL,
	"label" varchar(120) NOT NULL,
	"is_baseline" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiment_prompt_versions_pk" PRIMARY KEY("experiment_id","prompt_version_id")
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"dataset_version_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"name" varchar(240) NOT NULL,
	"description" text,
	"status" "experiment_status" DEFAULT 'draft' NOT NULL,
	"random_seed" bigint NOT NULL,
	"repetitions" integer DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" varchar(255),
	"failure_code" varchar(120),
	"failure_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiments_repetitions_positive" CHECK ("experiments"."repetitions" > 0)
);
--> statement-breakpoint
CREATE TABLE "generation_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"status" "generation_output_status" DEFAULT 'pending' NOT NULL,
	"request" jsonb,
	"output_text" text,
	"raw_response" jsonb,
	"output_hash" varchar(64),
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(16, 8),
	"provider_request_id" varchar(255),
	"error_code" varchar(120),
	"error_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "generation_outputs_attempts_nonnegative" CHECK ("generation_outputs"."attempt_count" >= 0),
	CONSTRAINT "generation_outputs_latency_nonnegative" CHECK ("generation_outputs"."latency_ms" is null or "generation_outputs"."latency_ms" >= 0),
	CONSTRAINT "generation_outputs_tokens_nonnegative" CHECK (
      ("generation_outputs"."input_tokens" is null or "generation_outputs"."input_tokens" >= 0)
      and ("generation_outputs"."output_tokens" is null or "generation_outputs"."output_tokens" >= 0)
    ),
	CONSTRAINT "generation_outputs_hash_format" CHECK ("generation_outputs"."output_hash" is null or "generation_outputs"."output_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"prompt_version_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"provider" varchar(120) NOT NULL,
	"model" varchar(240) NOT NULL,
	"model_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_config_hash" varchar(64) NOT NULL,
	"repetition" integer DEFAULT 1 NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"requested_count" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"failure_code" varchar(120),
	"failure_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_runs_repetition_positive" CHECK ("generation_runs"."repetition" > 0),
	CONSTRAINT "generation_runs_counts_nonnegative" CHECK (
      "generation_runs"."requested_count" >= 0 and "generation_runs"."succeeded_count" >= 0 and "generation_runs"."failed_count" >= 0
    ),
	CONSTRAINT "generation_runs_config_hash_format" CHECK ("generation_runs"."model_config_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "version_status" DEFAULT 'draft' NOT NULL,
	"blocks" jsonb NOT NULL,
	"compiled_content" text NOT NULL,
	"source_map" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"parent_version_id" uuid,
	"change_summary" text,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "prompt_versions_version_positive" CHECK ("prompt_versions"."version" > 0),
	CONSTRAINT "prompt_versions_blocks_nonempty" CHECK (jsonb_array_length("prompt_versions"."blocks") > 0),
	CONSTRAINT "prompt_versions_hash_format" CHECK ("prompt_versions"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_run_id" uuid NOT NULL,
	"generation_output_id" uuid NOT NULL,
	"kind" "score_kind" DEFAULT 'dimension' NOT NULL,
	"metric_key" varchar(120) NOT NULL,
	"score" numeric(12, 6) NOT NULL,
	"min_score" numeric(12, 6) NOT NULL,
	"max_score" numeric(12, 6) NOT NULL,
	"normalized_score" numeric(12, 9),
	"passed" boolean,
	"confidence" numeric(6, 5),
	"rationale" text,
	"evidence" jsonb,
	"raw_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scores_bounds_valid" CHECK ("scores"."max_score" > "scores"."min_score"),
	CONSTRAINT "scores_value_in_bounds" CHECK ("scores"."score" >= "scores"."min_score" and "scores"."score" <= "scores"."max_score"),
	CONSTRAINT "scores_normalized_range" CHECK ("scores"."normalized_score" is null or ("scores"."normalized_score" >= 0 and "scores"."normalized_score" <= 1)),
	CONSTRAINT "scores_confidence_range" CHECK ("scores"."confidence" is null or ("scores"."confidence" >= 0 and "scores"."confidence" <= 1))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_parent_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."dataset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_runs" ADD CONSTRAINT "diagnosis_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_dataset_version_id_dataset_versions_id_fk" FOREIGN KEY ("dataset_version_id") REFERENCES "public"."dataset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_framework_versions" ADD CONSTRAINT "evaluation_framework_versions_framework_id_evaluation_frameworks_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."evaluation_frameworks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_framework_versions" ADD CONSTRAINT "framework_versions_parent_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."evaluation_framework_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_frameworks" ADD CONSTRAINT "evaluation_frameworks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_generation_run_id_generation_runs_id_fk" FOREIGN KEY ("generation_run_id") REFERENCES "public"."generation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_framework_version_id_evaluation_framework_versions_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."evaluation_framework_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_prompt_versions" ADD CONSTRAINT "experiment_prompt_versions_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_prompt_versions" ADD CONSTRAINT "experiment_prompt_versions_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_dataset_version_id_dataset_versions_id_fk" FOREIGN KEY ("dataset_version_id") REFERENCES "public"."dataset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_framework_version_id_evaluation_framework_versions_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."evaluation_framework_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_outputs" ADD CONSTRAINT "generation_outputs_generation_run_id_generation_runs_id_fk" FOREIGN KEY ("generation_run_id") REFERENCES "public"."generation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_outputs" ADD CONSTRAINT "generation_outputs_case_id_evaluation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."evaluation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_parent_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_generation_output_id_generation_outputs_id_fk" FOREIGN KEY ("generation_output_id") REFERENCES "public"."generation_outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_sequence_uq" ON "audit_events" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "audit_events_project_time_idx" ON "audit_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_time_idx" ON "audit_events" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_request_idx" ON "audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_versions_dataset_version_uq" ON "dataset_versions" USING btree ("dataset_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_versions_dataset_hash_uq" ON "dataset_versions" USING btree ("dataset_id","content_hash");--> statement-breakpoint
CREATE INDEX "dataset_versions_dataset_status_idx" ON "dataset_versions" USING btree ("dataset_id","status");--> statement-breakpoint
CREATE INDEX "dataset_versions_parent_idx" ON "dataset_versions" USING btree ("parent_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "datasets_project_key_uq" ON "datasets" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "datasets_project_created_at_idx" ON "datasets" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "diagnosis_runs_project_created_at_idx" ON "diagnosis_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "diagnosis_runs_status_created_at_idx" ON "diagnosis_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "diagnosis_runs_bundle_id_idx" ON "diagnosis_runs" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "diagnosis_runs_report_id_idx" ON "diagnosis_runs" USING btree ("report_id") WHERE "diagnosis_runs"."report_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_cases_version_key_uq" ON "evaluation_cases" USING btree ("dataset_version_id","case_key");--> statement-breakpoint
CREATE INDEX "evaluation_cases_version_order_idx" ON "evaluation_cases" USING btree ("dataset_version_id","sort_order");--> statement-breakpoint
CREATE INDEX "evaluation_cases_hash_idx" ON "evaluation_cases" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "framework_versions_framework_version_uq" ON "evaluation_framework_versions" USING btree ("framework_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "framework_versions_framework_hash_uq" ON "evaluation_framework_versions" USING btree ("framework_id","content_hash");--> statement-breakpoint
CREATE INDEX "framework_versions_framework_status_idx" ON "evaluation_framework_versions" USING btree ("framework_id","status");--> statement-breakpoint
CREATE INDEX "framework_versions_parent_idx" ON "evaluation_framework_versions" USING btree ("parent_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_frameworks_project_key_uq" ON "evaluation_frameworks" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "evaluation_frameworks_project_created_at_idx" ON "evaluation_frameworks" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_runs_idempotency_uq" ON "evaluation_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_runs_generation_evaluator_uq" ON "evaluation_runs" USING btree ("generation_run_id","framework_version_id","evaluator_key","evaluator_version","evaluator_config_hash");--> statement-breakpoint
CREATE INDEX "evaluation_runs_experiment_status_idx" ON "evaluation_runs" USING btree ("experiment_id","status");--> statement-breakpoint
CREATE INDEX "evaluation_runs_generation_idx" ON "evaluation_runs" USING btree ("generation_run_id");--> statement-breakpoint
CREATE INDEX "evaluation_runs_framework_idx" ON "evaluation_runs" USING btree ("framework_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_prompt_versions_label_uq" ON "experiment_prompt_versions" USING btree ("experiment_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_prompt_versions_one_baseline_uq" ON "experiment_prompt_versions" USING btree ("experiment_id") WHERE "experiment_prompt_versions"."is_baseline";--> statement-breakpoint
CREATE INDEX "experiment_prompt_versions_prompt_idx" ON "experiment_prompt_versions" USING btree ("prompt_version_id");--> statement-breakpoint
CREATE INDEX "experiments_project_created_at_idx" ON "experiments" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "experiments_project_status_idx" ON "experiments" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "experiments_dataset_version_idx" ON "experiments" USING btree ("dataset_version_id");--> statement-breakpoint
CREATE INDEX "experiments_framework_version_idx" ON "experiments" USING btree ("framework_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_outputs_run_case_uq" ON "generation_outputs" USING btree ("generation_run_id","case_id");--> statement-breakpoint
CREATE INDEX "generation_outputs_run_status_idx" ON "generation_outputs" USING btree ("generation_run_id","status");--> statement-breakpoint
CREATE INDEX "generation_outputs_case_idx" ON "generation_outputs" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_runs_idempotency_uq" ON "generation_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_runs_experiment_prompt_repetition_uq" ON "generation_runs" USING btree ("experiment_id","prompt_version_id","repetition","model_config_hash");--> statement-breakpoint
CREATE INDEX "generation_runs_experiment_status_idx" ON "generation_runs" USING btree ("experiment_id","status");--> statement-breakpoint
CREATE INDEX "generation_runs_prompt_version_idx" ON "generation_runs" USING btree ("prompt_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_uq" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "projects_created_at_idx" ON "projects" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_prompt_version_uq" ON "prompt_versions" USING btree ("prompt_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_prompt_hash_uq" ON "prompt_versions" USING btree ("prompt_id","content_hash");--> statement-breakpoint
CREATE INDEX "prompt_versions_prompt_status_idx" ON "prompt_versions" USING btree ("prompt_id","status");--> statement-breakpoint
CREATE INDEX "prompt_versions_parent_idx" ON "prompt_versions" USING btree ("parent_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_project_key_uq" ON "prompts" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "prompts_project_created_at_idx" ON "prompts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scores_run_output_metric_uq" ON "scores" USING btree ("evaluation_run_id","generation_output_id","kind","metric_key");--> statement-breakpoint
CREATE INDEX "scores_run_metric_idx" ON "scores" USING btree ("evaluation_run_id","metric_key");--> statement-breakpoint
CREATE INDEX "scores_output_idx" ON "scores" USING btree ("generation_output_id");
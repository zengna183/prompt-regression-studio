CREATE TABLE "ablation_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_experiment_id" uuid NOT NULL,
	"candidate_prompt_version_id" uuid NOT NULL,
	"reverted_block_id" varchar(80) NOT NULL,
	"experiment_id" uuid NOT NULL,
	"variant_prompt_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ablation_experiments" ADD CONSTRAINT "ablation_experiments_source_experiment_id_experiments_id_fk" FOREIGN KEY ("source_experiment_id") REFERENCES "public"."experiments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ablation_experiments" ADD CONSTRAINT "ablation_experiments_candidate_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("candidate_prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ablation_experiments" ADD CONSTRAINT "ablation_experiments_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ablation_experiments" ADD CONSTRAINT "ablation_experiments_variant_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("variant_prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ablation_source_candidate_block_uq" ON "ablation_experiments" USING btree ("source_experiment_id","candidate_prompt_version_id","reverted_block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ablation_experiment_uq" ON "ablation_experiments" USING btree ("experiment_id");
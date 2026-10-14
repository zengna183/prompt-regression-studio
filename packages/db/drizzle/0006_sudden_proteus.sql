CREATE TABLE "model_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"base_url" varchar(2048) NOT NULL,
	"allowed_models" jsonb NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"supports_seed" boolean DEFAULT true NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD COLUMN "model_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "model_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_connections_project_name_uq" ON "model_connections" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "model_connections_project_id_uq" ON "model_connections" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "model_connections_project_created_at_idx" ON "model_connections" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_model_connection_id_model_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."model_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_model_connection_id_model_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."model_connections"("id") ON DELETE restrict ON UPDATE no action;
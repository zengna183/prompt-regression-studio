ALTER TABLE "experiments" ADD COLUMN "cost_budget_usd" numeric(16, 8);--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "cost_reserved_usd" numeric(16, 8) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "cost_pricing" jsonb;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_cost_budget_positive" CHECK ("experiments"."cost_budget_usd" is null or "experiments"."cost_budget_usd" > 0);--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_cost_reserved_nonnegative" CHECK ("experiments"."cost_reserved_usd" >= 0);--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_cost_reserved_within_budget" CHECK ("experiments"."cost_budget_usd" is null or "experiments"."cost_reserved_usd" <= "experiments"."cost_budget_usd");
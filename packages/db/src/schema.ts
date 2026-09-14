import { relations, sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PromptBlockKind =
  "role" | "policy" | "context" | "examples" | "output_format" | "custom";

export interface PromptBlock {
  readonly id: string;
  readonly kind: PromptBlockKind;
  readonly name: string;
  readonly content: string;
}

export interface PromptSourceRange {
  readonly blockId: string;
  /** Inclusive UTF-16 offset in compiled_content. */
  readonly start: number;
  /** Exclusive UTF-16 offset in compiled_content. */
  readonly end: number;
}

export interface FrameworkScoreGuide {
  readonly score: number;
  readonly description: string;
}

export interface FrameworkDimension {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly weight: number;
  readonly scoringGuide: readonly FrameworkScoreGuide[];
}

export interface FrameworkLevel {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface FrameworkDefinition {
  readonly levels: readonly FrameworkLevel[];
  readonly dimensions: readonly FrameworkDimension[];
}

export const versionStatusEnum = pgEnum("version_status", ["draft", "published", "archived"]);
export const datasetSourceEnum = pgEnum("dataset_source", [
  "manual",
  "ai_generated",
  "imported",
  "mixed",
]);
export const experimentStatusEnum = pgEnum("experiment_status", [
  "draft",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
]);
export const generationOutputStatusEnum = pgEnum("generation_output_status", [
  "pending",
  "succeeded",
  "failed",
  "skipped",
]);
export const scoreKindEnum = pgEnum("score_kind", ["dimension", "overall", "rule"]);
export const auditActorTypeEnum = pgEnum("audit_actor_type", ["user", "service", "system"]);
export const diagnosisRunStatusEnum = pgEnum("diagnosis_run_status", [
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

function timestampColumns() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  };
}

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("projects_slug_uq").on(table.slug),
    index("projects_created_at_idx").on(table.createdAt),
  ],
);

export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("prompts_project_key_uq").on(table.projectId, table.key),
    index("prompts_project_created_at_idx").on(table.projectId, table.createdAt),
  ],
);

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: versionStatusEnum("status").notNull().default("draft"),
    blocks: jsonb("blocks").$type<PromptBlock[]>().notNull(),
    compiledContent: text("compiled_content").notNull(),
    sourceMap: jsonb("source_map").$type<PromptSourceRange[]>().notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    parentVersionId: uuid("parent_version_id"),
    changeSummary: text("change_summary"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("prompt_versions_prompt_version_uq").on(table.promptId, table.version),
    uniqueIndex("prompt_versions_prompt_hash_uq").on(table.promptId, table.contentHash),
    index("prompt_versions_prompt_status_idx").on(table.promptId, table.status),
    index("prompt_versions_parent_idx").on(table.parentVersionId),
    foreignKey({
      name: "prompt_versions_parent_fk",
      columns: [table.parentVersionId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
    check("prompt_versions_version_positive", sql`${table.version} > 0`),
    check("prompt_versions_blocks_nonempty", sql`jsonb_array_length(${table.blocks}) > 0`),
    check("prompt_versions_hash_format", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const evaluationFrameworks = pgTable(
  "evaluation_frameworks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("evaluation_frameworks_project_key_uq").on(table.projectId, table.key),
    index("evaluation_frameworks_project_created_at_idx").on(table.projectId, table.createdAt),
  ],
);

export const evaluationFrameworkVersions = pgTable(
  "evaluation_framework_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    frameworkId: uuid("framework_id")
      .notNull()
      .references(() => evaluationFrameworks.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: versionStatusEnum("status").notNull().default("draft"),
    definition: jsonb("definition").$type<FrameworkDefinition>().notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    parentVersionId: uuid("parent_version_id"),
    changeSummary: text("change_summary"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("framework_versions_framework_version_uq").on(table.frameworkId, table.version),
    uniqueIndex("framework_versions_framework_hash_uq").on(table.frameworkId, table.contentHash),
    index("framework_versions_framework_status_idx").on(table.frameworkId, table.status),
    index("framework_versions_parent_idx").on(table.parentVersionId),
    foreignKey({
      name: "framework_versions_parent_fk",
      columns: [table.parentVersionId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
    check("framework_versions_version_positive", sql`${table.version} > 0`),
    check("framework_versions_hash_format", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const datasets = pgTable(
  "datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("datasets_project_key_uq").on(table.projectId, table.key),
    index("datasets_project_created_at_idx").on(table.projectId, table.createdAt),
  ],
);

export const datasetVersions = pgTable(
  "dataset_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: versionStatusEnum("status").notNull().default("draft"),
    source: datasetSourceEnum("source").notNull().default("manual"),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    caseCount: integer("case_count").notNull().default(0),
    generationProvenance: jsonb("generation_provenance").$type<JsonValue>(),
    parentVersionId: uuid("parent_version_id"),
    changeSummary: text("change_summary"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("dataset_versions_dataset_version_uq").on(table.datasetId, table.version),
    uniqueIndex("dataset_versions_dataset_hash_uq").on(table.datasetId, table.contentHash),
    index("dataset_versions_dataset_status_idx").on(table.datasetId, table.status),
    index("dataset_versions_parent_idx").on(table.parentVersionId),
    foreignKey({
      name: "dataset_versions_parent_fk",
      columns: [table.parentVersionId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
    check("dataset_versions_version_positive", sql`${table.version} > 0`),
    check("dataset_versions_case_count_nonnegative", sql`${table.caseCount} >= 0`),
    check("dataset_versions_hash_format", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const evaluationCases = pgTable(
  "evaluation_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetVersionId: uuid("dataset_version_id")
      .notNull()
      .references(() => datasetVersions.id, { onDelete: "cascade" }),
    caseKey: varchar("case_key", { length: 120 }).notNull(),
    name: varchar("name", { length: 240 }),
    input: jsonb("input").$type<JsonValue>().notNull(),
    expectedOutput: jsonb("expected_output").$type<JsonValue>(),
    metadata: jsonb("metadata")
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("evaluation_cases_version_key_uq").on(table.datasetVersionId, table.caseKey),
    index("evaluation_cases_version_order_idx").on(table.datasetVersionId, table.sortOrder),
    index("evaluation_cases_hash_idx").on(table.contentHash),
    check("evaluation_cases_sort_order_nonnegative", sql`${table.sortOrder} >= 0`),
    check("evaluation_cases_hash_format", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    datasetVersionId: uuid("dataset_version_id")
      .notNull()
      .references(() => datasetVersions.id, { onDelete: "restrict" }),
    frameworkVersionId: uuid("framework_version_id")
      .notNull()
      .references(() => evaluationFrameworkVersions.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 240 }).notNull(),
    description: text("description"),
    status: experimentStatusEnum("status").notNull().default("draft"),
    randomSeed: bigint("random_seed", { mode: "number" }).notNull(),
    repetitions: integer("repetitions").notNull().default(1),
    config: jsonb("config")
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: varchar("created_by", { length: 255 }),
    failureCode: varchar("failure_code", { length: 120 }),
    failureMessage: text("failure_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    ...timestampColumns(),
  },
  (table) => [
    index("experiments_project_created_at_idx").on(table.projectId, table.createdAt),
    index("experiments_project_status_idx").on(table.projectId, table.status),
    index("experiments_dataset_version_idx").on(table.datasetVersionId),
    index("experiments_framework_version_idx").on(table.frameworkVersionId),
    check("experiments_repetitions_positive", sql`${table.repetitions} > 0`),
  ],
);

/** A normalized join keeps every compared Prompt version reproducibly pinned. */
export const experimentPromptVersions = pgTable(
  "experiment_prompt_versions",
  {
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    promptVersionId: uuid("prompt_version_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    label: varchar("label", { length: 120 }).notNull(),
    isBaseline: boolean("is_baseline").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "experiment_prompt_versions_pk",
      columns: [table.experimentId, table.promptVersionId],
    }),
    uniqueIndex("experiment_prompt_versions_label_uq").on(table.experimentId, table.label),
    uniqueIndex("experiment_prompt_versions_one_baseline_uq")
      .on(table.experimentId)
      .where(sql`${table.isBaseline}`),
    index("experiment_prompt_versions_prompt_idx").on(table.promptVersionId),
  ],
);

export const generationRuns = pgTable(
  "generation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    promptVersionId: uuid("prompt_version_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    status: runStatusEnum("status").notNull().default("queued"),
    provider: varchar("provider", { length: 120 }).notNull(),
    model: varchar("model", { length: 240 }).notNull(),
    modelConfig: jsonb("model_config")
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    modelConfigHash: varchar("model_config_hash", { length: 64 }).notNull(),
    repetition: integer("repetition").notNull().default(1),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    requestedCount: integer("requested_count").notNull().default(0),
    succeededCount: integer("succeeded_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    failureCode: varchar("failure_code", { length: 120 }),
    failureMessage: text("failure_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("generation_runs_idempotency_uq").on(table.idempotencyKey),
    uniqueIndex("generation_runs_experiment_prompt_repetition_uq").on(
      table.experimentId,
      table.promptVersionId,
      table.repetition,
      table.modelConfigHash,
    ),
    index("generation_runs_experiment_status_idx").on(table.experimentId, table.status),
    index("generation_runs_prompt_version_idx").on(table.promptVersionId),
    check("generation_runs_repetition_positive", sql`${table.repetition} > 0`),
    check(
      "generation_runs_counts_nonnegative",
      sql`
      ${table.requestedCount} >= 0 and ${table.succeededCount} >= 0 and ${table.failedCount} >= 0
    `,
    ),
    check("generation_runs_config_hash_format", sql`${table.modelConfigHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Raw model answers are independent from grading, so old answers can be re-evaluated. */
export const generationOutputs = pgTable(
  "generation_outputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generationRunId: uuid("generation_run_id")
      .notNull()
      .references(() => generationRuns.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => evaluationCases.id, { onDelete: "restrict" }),
    status: generationOutputStatusEnum("status").notNull().default("pending"),
    request: jsonb("request").$type<JsonValue>(),
    outputText: text("output_text"),
    rawResponse: jsonb("raw_response").$type<JsonValue>(),
    outputHash: varchar("output_hash", { length: 64 }),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 16, scale: 8, mode: "number" }),
    providerRequestId: varchar("provider_request_id", { length: 255 }),
    errorCode: varchar("error_code", { length: 120 }),
    errorMessage: text("error_message"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("generation_outputs_run_case_uq").on(table.generationRunId, table.caseId),
    index("generation_outputs_run_status_idx").on(table.generationRunId, table.status),
    index("generation_outputs_case_idx").on(table.caseId),
    check("generation_outputs_attempts_nonnegative", sql`${table.attemptCount} >= 0`),
    check(
      "generation_outputs_latency_nonnegative",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    check(
      "generation_outputs_tokens_nonnegative",
      sql`
      (${table.inputTokens} is null or ${table.inputTokens} >= 0)
      and (${table.outputTokens} is null or ${table.outputTokens} >= 0)
    `,
    ),
    check(
      "generation_outputs_hash_format",
      sql`${table.outputHash} is null or ${table.outputHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const evaluationRuns = pgTable(
  "evaluation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    generationRunId: uuid("generation_run_id")
      .notNull()
      .references(() => generationRuns.id, { onDelete: "cascade" }),
    frameworkVersionId: uuid("framework_version_id")
      .notNull()
      .references(() => evaluationFrameworkVersions.id, { onDelete: "restrict" }),
    status: runStatusEnum("status").notNull().default("queued"),
    evaluatorKey: varchar("evaluator_key", { length: 120 }).notNull(),
    evaluatorVersion: varchar("evaluator_version", { length: 120 }).notNull(),
    evaluatorConfig: jsonb("evaluator_config")
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    evaluatorConfigHash: varchar("evaluator_config_hash", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    requestedCount: integer("requested_count").notNull().default(0),
    succeededCount: integer("succeeded_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    failureCode: varchar("failure_code", { length: 120 }),
    failureMessage: text("failure_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("evaluation_runs_idempotency_uq").on(table.idempotencyKey),
    uniqueIndex("evaluation_runs_generation_evaluator_uq").on(
      table.generationRunId,
      table.frameworkVersionId,
      table.evaluatorKey,
      table.evaluatorVersion,
      table.evaluatorConfigHash,
    ),
    index("evaluation_runs_experiment_status_idx").on(table.experimentId, table.status),
    index("evaluation_runs_generation_idx").on(table.generationRunId),
    index("evaluation_runs_framework_idx").on(table.frameworkVersionId),
    check(
      "evaluation_runs_counts_nonnegative",
      sql`
      ${table.requestedCount} >= 0 and ${table.succeededCount} >= 0 and ${table.failedCount} >= 0
    `,
    ),
    check(
      "evaluation_runs_config_hash_format",
      sql`${table.evaluatorConfigHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const scores = pgTable(
  "scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evaluationRunId: uuid("evaluation_run_id")
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: "cascade" }),
    generationOutputId: uuid("generation_output_id")
      .notNull()
      .references(() => generationOutputs.id, { onDelete: "cascade" }),
    kind: scoreKindEnum("kind").notNull().default("dimension"),
    /** Dimension id, rule id, or the reserved value __overall__. */
    metricKey: varchar("metric_key", { length: 120 }).notNull(),
    score: numeric("score", { precision: 12, scale: 6, mode: "number" }).notNull(),
    minScore: numeric("min_score", { precision: 12, scale: 6, mode: "number" }).notNull(),
    maxScore: numeric("max_score", { precision: 12, scale: 6, mode: "number" }).notNull(),
    normalizedScore: numeric("normalized_score", { precision: 12, scale: 9, mode: "number" }),
    passed: boolean("passed"),
    confidence: numeric("confidence", { precision: 6, scale: 5, mode: "number" }),
    rationale: text("rationale"),
    evidence: jsonb("evidence").$type<JsonValue>(),
    rawResult: jsonb("raw_result").$type<JsonValue>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("scores_run_output_metric_uq").on(
      table.evaluationRunId,
      table.generationOutputId,
      table.kind,
      table.metricKey,
    ),
    index("scores_run_metric_idx").on(table.evaluationRunId, table.metricKey),
    index("scores_output_idx").on(table.generationOutputId),
    check("scores_bounds_valid", sql`${table.maxScore} > ${table.minScore}`),
    check(
      "scores_value_in_bounds",
      sql`${table.score} >= ${table.minScore} and ${table.score} <= ${table.maxScore}`,
    ),
    check(
      "scores_normalized_range",
      sql`${table.normalizedScore} is null or (${table.normalizedScore} >= 0 and ${table.normalizedScore} <= 1)`,
    ),
    check(
      "scores_confidence_range",
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),
  ],
);

/**
 * Immutable diagnosis inputs and terminal reports form the durable audit record for a
 * baseline/candidate comparison. The report remains JSON because its language-neutral
 * schema is versioned independently by Stable Core; indexed identity and lifecycle
 * fields stay relational so the product can query them without understanding every
 * report version.
 */
export const diagnosisRuns = pgTable(
  "diagnosis_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    bundleId: varchar("bundle_id", { length: 256 }).notNull(),
    inputBundle: jsonb("input_bundle").$type<JsonValue>().notNull(),
    inputBundleHash: varchar("input_bundle_hash", { length: 64 }),
    reportId: varchar("report_id", { length: 256 }),
    report: jsonb("report").$type<JsonValue>(),
    status: diagnosisRunStatusEnum("status").notNull().default("running"),
    failureCode: varchar("failure_code", { length: 120 }),
    failureMessage: text("failure_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    ...timestampColumns(),
  },
  (table) => [
    index("diagnosis_runs_project_created_at_idx").on(table.projectId, table.createdAt),
    index("diagnosis_runs_status_created_at_idx").on(table.status, table.createdAt),
    index("diagnosis_runs_bundle_id_idx").on(table.bundleId),
    index("diagnosis_runs_report_id_idx")
      .on(table.reportId)
      .where(sql`${table.reportId} is not null`),
    check(
      "diagnosis_runs_hash_format",
      sql`${table.inputBundleHash} is null or ${table.inputBundleHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "diagnosis_runs_terminal_shape",
      sql`(
        ${table.status} = 'running'
        and ${table.completedAt} is null
        and ${table.report} is null
        and ${table.reportId} is null
      ) or (
        ${table.status} = 'succeeded'
        and ${table.completedAt} is not null
        and ${table.report} is not null
        and ${table.reportId} is not null
        and ${table.inputBundleHash} is not null
        and ${table.failureCode} is null
        and ${table.failureMessage} is null
      ) or (
        ${table.status} in ('failed', 'cancelled')
        and ${table.completedAt} is not null
        and ${table.report} is null
        and ${table.reportId} is null
      )`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    actorType: auditActorTypeEnum("actor_type").notNull(),
    actorId: varchar("actor_id", { length: 255 }),
    action: varchar("action", { length: 160 }).notNull(),
    entityType: varchar("entity_type", { length: 120 }).notNull(),
    entityId: uuid("entity_id"),
    requestId: varchar("request_id", { length: 160 }),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity(),
    data: jsonb("data")
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("audit_events_sequence_uq").on(table.sequence),
    index("audit_events_project_time_idx").on(table.projectId, table.occurredAt),
    index("audit_events_entity_time_idx").on(table.entityType, table.entityId, table.occurredAt),
    index("audit_events_request_idx").on(table.requestId),
  ],
);

export const projectsRelations = relations(projects, ({ many }) => ({
  prompts: many(prompts),
  frameworks: many(evaluationFrameworks),
  datasets: many(datasets),
  experiments: many(experiments),
  diagnosisRuns: many(diagnosisRuns),
}));

export const diagnosisRunsRelations = relations(diagnosisRuns, ({ one }) => ({
  project: one(projects, {
    fields: [diagnosisRuns.projectId],
    references: [projects.id],
  }),
}));

export const promptsRelations = relations(prompts, ({ one, many }) => ({
  project: one(projects, { fields: [prompts.projectId], references: [projects.id] }),
  versions: many(promptVersions),
}));

export const promptVersionsRelations = relations(promptVersions, ({ one, many }) => ({
  prompt: one(prompts, { fields: [promptVersions.promptId], references: [prompts.id] }),
  parent: one(promptVersions, {
    relationName: "promptVersionParent",
    fields: [promptVersions.parentVersionId],
    references: [promptVersions.id],
  }),
  children: many(promptVersions, { relationName: "promptVersionParent" }),
}));

export const evaluationFrameworksRelations = relations(evaluationFrameworks, ({ one, many }) => ({
  project: one(projects, {
    fields: [evaluationFrameworks.projectId],
    references: [projects.id],
  }),
  versions: many(evaluationFrameworkVersions),
}));

export const evaluationFrameworkVersionsRelations = relations(
  evaluationFrameworkVersions,
  ({ one, many }) => ({
    framework: one(evaluationFrameworks, {
      fields: [evaluationFrameworkVersions.frameworkId],
      references: [evaluationFrameworks.id],
    }),
    parent: one(evaluationFrameworkVersions, {
      relationName: "frameworkVersionParent",
      fields: [evaluationFrameworkVersions.parentVersionId],
      references: [evaluationFrameworkVersions.id],
    }),
    children: many(evaluationFrameworkVersions, { relationName: "frameworkVersionParent" }),
  }),
);

export const datasetsRelations = relations(datasets, ({ one, many }) => ({
  project: one(projects, { fields: [datasets.projectId], references: [projects.id] }),
  versions: many(datasetVersions),
}));

export const datasetVersionsRelations = relations(datasetVersions, ({ one, many }) => ({
  dataset: one(datasets, { fields: [datasetVersions.datasetId], references: [datasets.id] }),
  parent: one(datasetVersions, {
    relationName: "datasetVersionParent",
    fields: [datasetVersions.parentVersionId],
    references: [datasetVersions.id],
  }),
  children: many(datasetVersions, { relationName: "datasetVersionParent" }),
  cases: many(evaluationCases),
}));

export const evaluationCasesRelations = relations(evaluationCases, ({ one, many }) => ({
  datasetVersion: one(datasetVersions, {
    fields: [evaluationCases.datasetVersionId],
    references: [datasetVersions.id],
  }),
  generationOutputs: many(generationOutputs),
}));

export const experimentsRelations = relations(experiments, ({ one, many }) => ({
  project: one(projects, { fields: [experiments.projectId], references: [projects.id] }),
  datasetVersion: one(datasetVersions, {
    fields: [experiments.datasetVersionId],
    references: [datasetVersions.id],
  }),
  frameworkVersion: one(evaluationFrameworkVersions, {
    fields: [experiments.frameworkVersionId],
    references: [evaluationFrameworkVersions.id],
  }),
  promptVersions: many(experimentPromptVersions),
  generationRuns: many(generationRuns),
  evaluationRuns: many(evaluationRuns),
}));

export const experimentPromptVersionsRelations = relations(experimentPromptVersions, ({ one }) => ({
  experiment: one(experiments, {
    fields: [experimentPromptVersions.experimentId],
    references: [experiments.id],
  }),
  promptVersion: one(promptVersions, {
    fields: [experimentPromptVersions.promptVersionId],
    references: [promptVersions.id],
  }),
}));

export const generationRunsRelations = relations(generationRuns, ({ one, many }) => ({
  experiment: one(experiments, {
    fields: [generationRuns.experimentId],
    references: [experiments.id],
  }),
  promptVersion: one(promptVersions, {
    fields: [generationRuns.promptVersionId],
    references: [promptVersions.id],
  }),
  outputs: many(generationOutputs),
  evaluationRuns: many(evaluationRuns),
}));

export const generationOutputsRelations = relations(generationOutputs, ({ one, many }) => ({
  run: one(generationRuns, {
    fields: [generationOutputs.generationRunId],
    references: [generationRuns.id],
  }),
  evaluationCase: one(evaluationCases, {
    fields: [generationOutputs.caseId],
    references: [evaluationCases.id],
  }),
  scores: many(scores),
}));

export const evaluationRunsRelations = relations(evaluationRuns, ({ one, many }) => ({
  experiment: one(experiments, {
    fields: [evaluationRuns.experimentId],
    references: [experiments.id],
  }),
  generationRun: one(generationRuns, {
    fields: [evaluationRuns.generationRunId],
    references: [generationRuns.id],
  }),
  frameworkVersion: one(evaluationFrameworkVersions, {
    fields: [evaluationRuns.frameworkVersionId],
    references: [evaluationFrameworkVersions.id],
  }),
  scores: many(scores),
}));

export const scoresRelations = relations(scores, ({ one }) => ({
  evaluationRun: one(evaluationRuns, {
    fields: [scores.evaluationRunId],
    references: [evaluationRuns.id],
  }),
  generationOutput: one(generationOutputs, {
    fields: [scores.generationOutputId],
    references: [generationOutputs.id],
  }),
}));

export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;
export type Prompt = InferSelectModel<typeof prompts>;
export type NewPrompt = InferInsertModel<typeof prompts>;
export type PromptVersion = InferSelectModel<typeof promptVersions>;
export type NewPromptVersion = InferInsertModel<typeof promptVersions>;
export type EvaluationFramework = InferSelectModel<typeof evaluationFrameworks>;
export type NewEvaluationFramework = InferInsertModel<typeof evaluationFrameworks>;
export type EvaluationFrameworkVersion = InferSelectModel<typeof evaluationFrameworkVersions>;
export type NewEvaluationFrameworkVersion = InferInsertModel<typeof evaluationFrameworkVersions>;
export type Dataset = InferSelectModel<typeof datasets>;
export type DatasetVersion = InferSelectModel<typeof datasetVersions>;
export type EvaluationCase = InferSelectModel<typeof evaluationCases>;
export type Experiment = InferSelectModel<typeof experiments>;
export type GenerationRun = InferSelectModel<typeof generationRuns>;
export type GenerationOutput = InferSelectModel<typeof generationOutputs>;
export type EvaluationRun = InferSelectModel<typeof evaluationRuns>;
export type Score = InferSelectModel<typeof scores>;
export type DiagnosisRun = InferSelectModel<typeof diagnosisRuns>;
export type NewDiagnosisRun = InferInsertModel<typeof diagnosisRuns>;
export type AuditEvent = InferSelectModel<typeof auditEvents>;

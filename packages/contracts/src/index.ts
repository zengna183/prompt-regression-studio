import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const UuidSchema = Type.String({ format: "uuid" });
export const IsoDateSchema = Type.String({ format: "date-time" });

export const ErrorResponseSchema = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    requestId: Type.Optional(Type.String()),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ProjectSchema = Type.Object(
  {
    id: UuidSchema,
    slug: Type.String(),
    name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  },
  { additionalProperties: false },
);

export const CreateProjectSchema = Type.Object(
  {
    slug: Type.String({ minLength: 2, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    name: Type.String({ minLength: 2, maxLength: 120 }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const PromptBlockKindSchema = Type.Union([
  Type.Literal("role"),
  Type.Literal("policy"),
  Type.Literal("context"),
  Type.Literal("examples"),
  Type.Literal("output_format"),
  Type.Literal("custom"),
]);

export const PromptBlockSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9_-]+$" }),
    kind: PromptBlockKindSchema,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    content: Type.String({ minLength: 1, maxLength: 100000 }),
  },
  { additionalProperties: false },
);

export const PromptSchema = Type.Object(
  {
    id: UuidSchema,
    projectId: UuidSchema,
    key: Type.String(),
    name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  },
  { additionalProperties: false },
);

export const CreatePromptSchema = Type.Object(
  {
    key: Type.String({ minLength: 2, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    name: Type.String({ minLength: 2, maxLength: 120 }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const PromptVersionStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("published"),
  Type.Literal("archived"),
]);

export const PromptVersionSchema = Type.Object(
  {
    id: UuidSchema,
    promptId: UuidSchema,
    version: Type.Integer({ minimum: 1 }),
    status: PromptVersionStatusSchema,
    blocks: Type.Array(PromptBlockSchema, { minItems: 1 }),
    contentHash: Type.String(),
    parentVersionId: Type.Union([UuidSchema, Type.Null()]),
    changeSummary: Type.Union([Type.String(), Type.Null()]),
    createdAt: IsoDateSchema,
    publishedAt: Type.Union([IsoDateSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const CreatePromptVersionSchema = Type.Object(
  {
    blocks: Type.Array(PromptBlockSchema, { minItems: 1, maxItems: 100 }),
    parentVersionId: Type.Optional(UuidSchema),
    changeSummary: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const FrameworkDimensionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9_-]+$" }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    weight: Type.Number({ minimum: 0, maximum: 1 }),
    scoringGuide: Type.Array(
      Type.Object(
        {
          score: Type.Integer({ minimum: 0, maximum: 5 }),
          description: Type.String({ minLength: 1, maxLength: 2000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 2 },
    ),
  },
  { additionalProperties: false },
);

export const FrameworkDefinitionSchema = Type.Object(
  {
    levels: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 40 }),
          name: Type.String({ minLength: 1, maxLength: 120 }),
          description: Type.String({ minLength: 1, maxLength: 2000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    dimensions: Type.Array(FrameworkDimensionSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const CreateFrameworkSchema = Type.Object(
  {
    key: Type.String({ minLength: 2, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    name: Type.String({ minLength: 2, maxLength: 120 }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const EvaluationFrameworkSchema = Type.Object(
  {
    id: UuidSchema,
    projectId: UuidSchema,
    key: Type.String(),
    name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  },
  { additionalProperties: false },
);

export const FrameworkVersionSchema = Type.Object(
  {
    id: UuidSchema,
    frameworkId: UuidSchema,
    version: Type.Integer({ minimum: 1 }),
    status: PromptVersionStatusSchema,
    definition: FrameworkDefinitionSchema,
    contentHash: Type.String(),
    parentVersionId: Type.Union([UuidSchema, Type.Null()]),
    changeSummary: Type.Union([Type.String(), Type.Null()]),
    createdAt: IsoDateSchema,
    publishedAt: Type.Union([IsoDateSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const CreateFrameworkVersionSchema = Type.Object(
  {
    definition: FrameworkDefinitionSchema,
    parentVersionId: Type.Optional(UuidSchema),
    changeSummary: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const DatasetSourceSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("ai_generated"),
  Type.Literal("imported"),
  Type.Literal("mixed"),
]);

export const DatasetSchema = Type.Object(
  {
    id: UuidSchema,
    projectId: UuidSchema,
    key: Type.String(),
    name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  },
  { additionalProperties: false },
);

export const CreateDatasetSchema = Type.Object(
  {
    key: Type.String({ minLength: 2, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    name: Type.String({ minLength: 2, maxLength: 120 }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const EvaluationCaseInputSchema = Type.Object(
  {
    caseKey: Type.String({
      minLength: 1,
      maxLength: 120,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
    }),
    name: Type.Optional(Type.String({ maxLength: 240 })),
    input: Type.Unknown(),
    expectedOutput: Type.Optional(Type.Unknown()),
    metadata: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 120 }), Type.Unknown()),
    ),
  },
  { additionalProperties: false },
);

export const CreateDatasetVersionSchema = Type.Object(
  {
    source: Type.Optional(DatasetSourceSchema),
    cases: Type.Array(EvaluationCaseInputSchema, { minItems: 1, maxItems: 5000 }),
    generationProvenance: Type.Optional(Type.Unknown()),
    parentVersionId: Type.Optional(UuidSchema),
    changeSummary: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const DatasetVersionSchema = Type.Object(
  {
    id: UuidSchema,
    datasetId: UuidSchema,
    version: Type.Integer({ minimum: 1 }),
    status: PromptVersionStatusSchema,
    source: DatasetSourceSchema,
    contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    caseCount: Type.Integer({ minimum: 0 }),
    generationProvenance: Type.Unknown(),
    parentVersionId: Type.Union([UuidSchema, Type.Null()]),
    changeSummary: Type.Union([Type.String(), Type.Null()]),
    createdAt: IsoDateSchema,
    publishedAt: Type.Union([IsoDateSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const EvaluationCaseSchema = Type.Object(
  {
    id: UuidSchema,
    datasetVersionId: UuidSchema,
    caseKey: Type.String(),
    name: Type.Union([Type.String(), Type.Null()]),
    input: Type.Unknown(),
    expectedOutput: Type.Unknown(),
    metadata: Type.Record(Type.String(), Type.Unknown()),
    contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    sortOrder: Type.Integer({ minimum: 0 }),
    createdAt: IsoDateSchema,
  },
  { additionalProperties: false },
);

export const ExperimentStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const ExperimentPromptVersionSchema = Type.Object(
  {
    promptVersionId: UuidSchema,
    label: Type.String({ minLength: 1, maxLength: 120 }),
    isBaseline: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CreateExperimentSchema = Type.Object(
  {
    datasetVersionId: UuidSchema,
    frameworkVersionId: UuidSchema,
    name: Type.String({ minLength: 2, maxLength: 240 }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    randomSeed: Type.Integer({ minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 }),
    repetitions: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    config: Type.Optional(Type.Record(Type.String({ maxLength: 120 }), Type.Unknown())),
    promptVersions: Type.Array(ExperimentPromptVersionSchema, { minItems: 1, maxItems: 20 }),
  },
  { additionalProperties: false },
);

export const ExperimentSchema = Type.Object(
  {
    id: UuidSchema,
    projectId: UuidSchema,
    datasetVersionId: UuidSchema,
    frameworkVersionId: UuidSchema,
    name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    status: ExperimentStatusSchema,
    randomSeed: Type.Integer(),
    repetitions: Type.Integer({ minimum: 1 }),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  },
  { additionalProperties: false },
);

export const StartExperimentSchema = Type.Object(
  {
    provider: Type.Literal("openai-compatible"),
    model: Type.String({ minLength: 1, maxLength: 240 }),
    modelConfig: Type.Optional(
      Type.Object(
        {
          temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
          maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })),
        },
        { additionalProperties: false },
      ),
    ),
    evaluatorModel: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  },
  { additionalProperties: false },
);

export const StartedExperimentSchema = Type.Object(
  {
    experimentId: UuidSchema,
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    evaluationRunIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);

export const EvaluationRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("partially_succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const ExperimentProgressSchema = Type.Object(
  {
    plannedRuns: Type.Integer({ minimum: 1 }),
    createdRuns: Type.Integer({ minimum: 0 }),
    queuedRuns: Type.Integer({ minimum: 0 }),
    runningRuns: Type.Integer({ minimum: 0 }),
    succeededRuns: Type.Integer({ minimum: 0 }),
    partiallySucceededRuns: Type.Integer({ minimum: 0 }),
    failedRuns: Type.Integer({ minimum: 0 }),
    cancelledRuns: Type.Integer({ minimum: 0 }),
    completedRuns: Type.Integer({ minimum: 0 }),
    completionRate: Type.Number({ minimum: 0, maximum: 1 }),
    casesPerRun: Type.Integer({ minimum: 0 }),
    plannedCaseExecutions: Type.Integer({ minimum: 0 }),
    completedCaseExecutions: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ExperimentRunSummarySchema = Type.Object(
  {
    evaluationRunId: UuidSchema,
    generationRunId: UuidSchema,
    promptVersionId: UuidSchema,
    label: Type.String(),
    isBaseline: Type.Boolean(),
    repetition: Type.Integer({ minimum: 1 }),
    status: EvaluationRunStatusSchema,
    requestedCount: Type.Integer({ minimum: 0 }),
    succeededCount: Type.Integer({ minimum: 0 }),
    failedCount: Type.Integer({ minimum: 0 }),
    failureCode: Type.Union([Type.String(), Type.Null()]),
    failureMessage: Type.Union([Type.String(), Type.Null()]),
    startedAt: Type.Union([IsoDateSchema, Type.Null()]),
    completedAt: Type.Union([IsoDateSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const ExperimentDetailSchema = Type.Object(
  {
    experiment: ExperimentSchema,
    promptVersions: Type.Array(ExperimentPromptVersionSchema, { minItems: 1, maxItems: 20 }),
    progress: ExperimentProgressSchema,
    runs: Type.Array(ExperimentRunSummarySchema, { maxItems: 100 }),
    failureCode: Type.Union([Type.String(), Type.Null()]),
    failureMessage: Type.Union([Type.String(), Type.Null()]),
    startedAt: Type.Union([IsoDateSchema, Type.Null()]),
    completedAt: Type.Union([IsoDateSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export type Project = Static<typeof ProjectSchema>;
export type CreateProject = Static<typeof CreateProjectSchema>;
export type Prompt = Static<typeof PromptSchema>;
export type CreatePrompt = Static<typeof CreatePromptSchema>;
export type PromptBlock = Static<typeof PromptBlockSchema>;
export type PromptVersion = Static<typeof PromptVersionSchema>;
export type CreatePromptVersion = Static<typeof CreatePromptVersionSchema>;
export type FrameworkDefinition = Static<typeof FrameworkDefinitionSchema>;
export type EvaluationFramework = Static<typeof EvaluationFrameworkSchema>;
export type FrameworkVersion = Static<typeof FrameworkVersionSchema>;
export type CreateFramework = Static<typeof CreateFrameworkSchema>;
export type CreateFrameworkVersion = Static<typeof CreateFrameworkVersionSchema>;
export type DatasetSource = Static<typeof DatasetSourceSchema>;
export type Dataset = Static<typeof DatasetSchema>;
export type CreateDataset = Static<typeof CreateDatasetSchema>;
export type EvaluationCaseInput = Static<typeof EvaluationCaseInputSchema>;
export type CreateDatasetVersion = Static<typeof CreateDatasetVersionSchema>;
export type DatasetVersion = Static<typeof DatasetVersionSchema>;
export type EvaluationCase = Static<typeof EvaluationCaseSchema>;
export type ExperimentPromptVersion = Static<typeof ExperimentPromptVersionSchema>;
export type CreateExperiment = Static<typeof CreateExperimentSchema>;
export type Experiment = Static<typeof ExperimentSchema>;
export type StartExperiment = Static<typeof StartExperimentSchema>;
export type StartedExperiment = Static<typeof StartedExperimentSchema>;
export type EvaluationRunStatus = Static<typeof EvaluationRunStatusSchema>;
export type ExperimentProgress = Static<typeof ExperimentProgressSchema>;
export type ExperimentRunSummary = Static<typeof ExperimentRunSummarySchema>;
export type ExperimentDetail = Static<typeof ExperimentDetailSchema>;

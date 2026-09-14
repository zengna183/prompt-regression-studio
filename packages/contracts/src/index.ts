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

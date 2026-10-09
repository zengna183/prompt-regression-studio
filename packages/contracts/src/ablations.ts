import { Type, type Static } from "@sinclair/typebox";

// Local schemas avoid a circular dependency through the public barrel.
const Uuid = Type.String({ format: "uuid" });
export const CreateAblationSchema = Type.Object(
  {
    candidatePromptVersionId: Uuid,
    blockId: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" }),
  },
  { additionalProperties: false },
);

export const AblationSchema = Type.Object(
  {
    id: Uuid,
    sourceExperimentId: Uuid,
    candidatePromptVersionId: Uuid,
    revertedBlockId: Type.String(),
    experimentId: Uuid,
    variantPromptVersionId: Uuid,
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export type CreateAblation = Static<typeof CreateAblationSchema>;
export type Ablation = Static<typeof AblationSchema>;

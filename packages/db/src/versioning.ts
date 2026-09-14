import { createHash } from "node:crypto";

import type {
  FrameworkDefinition,
  FrameworkDimension,
  FrameworkLevel,
  FrameworkScoreGuide,
  PromptBlock,
  PromptBlockKind,
  PromptSourceRange,
} from "./schema.js";

export type VersionStatus = "draft" | "published" | "archived";

export class VersionContentError extends Error {
  override readonly name = "VersionContentError";

  constructor(message: string) {
    super(message);
  }
}

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new VersionContentError("Version content cannot contain NaN or Infinity");
    return value;
  }

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new VersionContentError(`Version content cannot contain ${typeof value}`);
  }

  if (typeof value === "bigint") {
    throw new VersionContentError("Version content cannot contain bigint");
  }

  if (typeof value !== "object") throw new VersionContentError("Unsupported version content");
  if (seen.has(value))
    throw new VersionContentError("Version content cannot contain circular references");
  seen.add(value);

  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new VersionContentError("Version content must contain only JSON objects and arrays");
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key], seen);
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Deterministic JSON: object keys are sorted while array order remains significant. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

export function hashVersionContent(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

const promptBlockKinds = new Set<PromptBlockKind>([
  "role",
  "policy",
  "context",
  "examples",
  "output_format",
  "custom",
]);
const stableIdPattern = /^[A-Za-z0-9_-]+$/;

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function requiredString(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new VersionContentError(`${field} is required`);
  }
  if (value.length > maxLength)
    throw new VersionContentError(`${field} must be at most ${maxLength} characters`);
  return value;
}

/** Validates and copies blocks. It deliberately preserves content whitespace and block order. */
export function normalizePromptBlocks(blocks: readonly PromptBlock[]): PromptBlock[] {
  if (!isRuntimeArray(blocks) || blocks.length === 0) {
    throw new VersionContentError("A Prompt version needs at least one block");
  }
  if (blocks.length > 100)
    throw new VersionContentError("A Prompt version can contain at most 100 blocks");

  const ids = new Set<string>();
  return blocks.map((block, index) => {
    const id = requiredString(block.id, `blocks[${index}].id`, 80);
    if (!stableIdPattern.test(id)) {
      throw new VersionContentError(
        `blocks[${index}].id may contain only letters, numbers, _ and -`,
      );
    }
    if (ids.has(id)) throw new VersionContentError(`Duplicate Prompt block id: ${id}`);
    ids.add(id);

    if (!promptBlockKinds.has(block.kind)) {
      throw new VersionContentError(`Unsupported Prompt block kind: ${String(block.kind)}`);
    }

    return {
      id,
      kind: block.kind,
      name: requiredString(block.name, `blocks[${index}].name`, 120),
      content: requiredString(block.content, `blocks[${index}].content`, 100_000),
    };
  });
}

export interface CompiledPrompt {
  readonly content: string;
  readonly sourceMap: PromptSourceRange[];
}

/** Compiles blocks without hidden text and records exact offsets for attribution UI. */
export function compilePrompt(blocks: readonly PromptBlock[]): CompiledPrompt {
  const normalized = normalizePromptBlocks(blocks);
  const sourceMap: PromptSourceRange[] = [];
  let content = "";

  normalized.forEach((block, index) => {
    if (index > 0) content += "\n\n";
    const start = content.length;
    content += block.content;
    sourceMap.push({ blockId: block.id, start, end: content.length });
  });

  return { content, sourceMap };
}

export function hashPromptBlocks(blocks: readonly PromptBlock[]): string {
  const normalized = normalizePromptBlocks(blocks);
  return hashVersionContent({ format: "prompt-blocks/v1", blocks: normalized });
}

function normalizeScoreGuide(
  guide: readonly FrameworkScoreGuide[],
  dimensionIndex: number,
): FrameworkScoreGuide[] {
  if (!isRuntimeArray(guide) || guide.length < 2) {
    throw new VersionContentError(
      `dimensions[${dimensionIndex}].scoringGuide needs at least two entries`,
    );
  }

  const scores = new Set<number>();
  const normalized = guide.map((entry, guideIndex) => {
    if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > 5) {
      throw new VersionContentError(
        `dimensions[${dimensionIndex}].scoringGuide[${guideIndex}].score must be an integer from 0 to 5`,
      );
    }
    if (scores.has(entry.score)) {
      throw new VersionContentError(
        `Duplicate score ${entry.score} in dimensions[${dimensionIndex}].scoringGuide`,
      );
    }
    scores.add(entry.score);
    return {
      score: entry.score,
      description: requiredString(
        entry.description,
        `dimensions[${dimensionIndex}].scoringGuide[${guideIndex}].description`,
        2_000,
      ),
    };
  });

  return normalized.sort((left, right) => left.score - right.score);
}

function normalizeLevel(level: FrameworkLevel, index: number, ids: Set<string>): FrameworkLevel {
  const id = requiredString(level.id, `levels[${index}].id`, 40);
  if (ids.has(id)) throw new VersionContentError(`Duplicate framework level id: ${id}`);
  ids.add(id);
  return {
    id,
    name: requiredString(level.name, `levels[${index}].name`, 120),
    description: requiredString(level.description, `levels[${index}].description`, 2_000),
  };
}

function normalizeDimension(
  dimension: FrameworkDimension,
  index: number,
  ids: Set<string>,
): FrameworkDimension {
  const id = requiredString(dimension.id, `dimensions[${index}].id`, 80);
  if (!stableIdPattern.test(id)) {
    throw new VersionContentError(
      `dimensions[${index}].id may contain only letters, numbers, _ and -`,
    );
  }
  if (ids.has(id)) throw new VersionContentError(`Duplicate framework dimension id: ${id}`);
  ids.add(id);
  if (!Number.isFinite(dimension.weight) || dimension.weight < 0 || dimension.weight > 1) {
    throw new VersionContentError(`dimensions[${index}].weight must be from 0 to 1`);
  }

  return {
    id,
    name: requiredString(dimension.name, `dimensions[${index}].name`, 120),
    description: requiredString(dimension.description, `dimensions[${index}].description`, 2_000),
    weight: dimension.weight,
    scoringGuide: normalizeScoreGuide(dimension.scoringGuide, index),
  };
}

/** Runtime validation protects persisted evaluation policy even when called outside the HTTP API. */
export function normalizeFrameworkDefinition(definition: FrameworkDefinition): FrameworkDefinition {
  if (!isRuntimeArray(definition.levels) || definition.levels.length === 0) {
    throw new VersionContentError("An evaluation framework needs at least one response level");
  }
  if (!isRuntimeArray(definition.dimensions) || definition.dimensions.length === 0) {
    throw new VersionContentError("An evaluation framework needs at least one scoring dimension");
  }

  const levelIds = new Set<string>();
  const dimensionIds = new Set<string>();
  const levels = definition.levels.map((level, index) => normalizeLevel(level, index, levelIds));
  const dimensions = definition.dimensions.map((dimension, index) =>
    normalizeDimension(dimension, index, dimensionIds),
  );
  if (dimensions.reduce((sum, dimension) => sum + dimension.weight, 0) <= 0) {
    throw new VersionContentError("At least one framework dimension must have a positive weight");
  }

  return { levels, dimensions };
}

export function hashFrameworkDefinition(definition: FrameworkDefinition): string {
  const normalized = normalizeFrameworkDefinition(definition);
  return hashVersionContent({ format: "evaluation-framework/v1", definition: normalized });
}

export function nextVersionNumber(currentMaximum: number | null | undefined): number {
  if (currentMaximum === null || currentMaximum === undefined) return 1;
  if (!Number.isSafeInteger(currentMaximum) || currentMaximum < 1) {
    throw new VersionContentError("Current version must be a positive safe integer");
  }
  if (currentMaximum === Number.MAX_SAFE_INTEGER)
    throw new VersionContentError("Version number overflow");
  return currentMaximum + 1;
}

export function assertCanPublish(status: VersionStatus): void {
  if (status !== "draft") {
    throw new VersionContentError(
      `Only draft versions can be published; current status is ${status}`,
    );
  }
}

export function assertCanArchive(status: VersionStatus): void {
  if (status === "archived") throw new VersionContentError("Version is already archived");
}

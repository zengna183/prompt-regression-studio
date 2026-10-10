import type { CreateExperimentDiagnosis } from "@ai-chat-eval/contracts";
import {
  revertPromptBlock,
  stableStringify,
  VersionContentError,
  type AblationExperiment,
  type ExperimentDiagnosisRecord,
} from "@ai-chat-eval/db";
import type { JsonObject } from "@prompt-regression/diagnosis-engine";

import {
  buildExperimentRegressionBundle,
  ExperimentDiagnosisBuildError,
} from "./experiment-diagnosis.js";

export interface RecordedAblationInput {
  readonly link: AblationExperiment;
  readonly record: ExperimentDiagnosisRecord;
}

/** Only server-owned lineage and saved complete results may become recorded evidence. */
export function buildRecordedAblationBundle(
  source: ExperimentDiagnosisRecord,
  input: CreateExperimentDiagnosis,
  ablations: readonly RecordedAblationInput[],
): JsonObject {
  if ((input.repetition ?? 1) !== 1)
    throw invalid("Recorded interventions currently support repetition 1 only.");
  if (ablations.length < 1 || ablations.length > 5)
    throw invalid("Select one to five completed interventions.");
  const original = buildExperimentRegressionBundle(source, input);
  const baseline = source.promptVersions.find((item) => item.isBaseline);
  const candidate = source.promptVersions.find(
    (item) => item.version.id === input.candidatePromptVersionId,
  );
  if (!baseline || !candidate) throw invalid("Source Prompt versions are missing.");
  const recorded = Object.create(null) as Record<string, JsonObject>;
  const runIds = new Set(source.runs.map((run) => run.evaluationRun.id));
  const experimentIds = new Set<string>();
  const originalCandidate = object(original.candidate_eval_run);
  let completedAt = stringField(original, "diagnosis_requested_at");
  for (const { link, record } of ablations) {
    if (
      link.sourceExperimentId !== source.experiment.id ||
      link.candidatePromptVersionId !== candidate.version.id ||
      link.experimentId !== record.experiment.id ||
      record.project.id !== source.project.id ||
      record.experiment.projectId !== source.project.id ||
      recorded[link.revertedBlockId] ||
      experimentIds.has(link.experimentId)
    ) {
      throw invalid("Intervention lineage does not match this source and candidate.");
    }
    experimentIds.add(link.experimentId);
    if (
      record.promptVersions.length !== 2 ||
      record.promptVersions.find((item) => item.isBaseline)?.version.id !== candidate.version.id
    ) {
      throw invalid(
        "The intervention must compare a fresh candidate replay with the saved reverted variant.",
      );
    }
    const selection = record.promptVersions.find(
      (item) => item.version.id === link.variantPromptVersionId && !item.isBaseline,
    );
    let expectedBlocks;
    try {
      expectedBlocks = revertPromptBlock(
        baseline.version.blocks,
        candidate.version.blocks,
        link.revertedBlockId,
      );
    } catch (error) {
      if (error instanceof TypeError || error instanceof VersionContentError)
        throw invalid("The saved intervention is not a valid single-block revert.");
      throw error;
    }
    if (
      !selection ||
      stableStringify(selection.version.blocks) !== stableStringify(expectedBlocks)
    ) {
      throw invalid("The saved variant does not match the declared single-block revert.");
    }
    const paired = buildExperimentRegressionBundle(record, {
      candidatePromptVersionId: link.variantPromptVersionId,
      repetition: 1,
      ...(input.detection ? { detection: input.detection } : {}),
    });
    const replay = object(paired.baseline_eval_run);
    const variant = object(paired.candidate_eval_run);
    if (
      stableStringify(original.dataset) !== stableStringify(paired.dataset) ||
      stableStringify(original.candidate_prompt_version) !==
        stableStringify(paired.baseline_prompt_version) ||
      stableStringify(originalCandidate.model_snapshot) !==
        stableStringify(replay.model_snapshot) ||
      stableStringify(originalCandidate.evaluator_snapshot) !==
        stableStringify(replay.evaluator_snapshot)
    ) {
      throw new ExperimentDiagnosisBuildError(
        409,
        "DIAGNOSIS_COMPARISON_CONFOUNDED",
        "Recorded interventions must use identical source data, Prompt and execution snapshots.",
      );
    }
    for (const run of [replay, variant]) {
      const id = stringField(run, "id");
      if (runIds.has(id)) throw invalid("Evidence must use fresh, distinct evaluation runs.");
      runIds.add(id);
    }
    recorded[link.revertedBlockId] = {
      id: link.id,
      source_experiment_id: source.experiment.id,
      experiment_id: link.experimentId,
      prompt_version: object(paired.candidate_prompt_version),
      eval_run: variant,
      candidate_replay_eval_run: replay,
    };
    const pairedCompletion = stringField(paired, "diagnosis_requested_at");
    if (Date.parse(pairedCompletion) > Date.parse(completedAt)) completedAt = pairedCompletion;
  }
  return {
    ...original,
    bundle_id: `${stringField(original, "bundle_id")}-recorded`,
    diagnosis_requested_at: completedAt,
    recorded_ablation_runs_by_segment: recorded,
  };
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("Saved bundle is missing a run snapshot.");
  return value as JsonObject;
}
function stringField(value: JsonObject, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0)
    throw invalid(`Saved bundle is missing ${key}.`);
  return field;
}
function invalid(message: string): ExperimentDiagnosisBuildError {
  return new ExperimentDiagnosisBuildError(422, "DIAGNOSIS_SELECTION_INVALID", message);
}

import { and, eq } from "drizzle-orm";

import { revertPromptBlock } from "../ablation.js";
import type { RepositoryDatabase } from "../client.js";
import { EntityNotFoundError, RepositoryConflictError } from "../errors.js";
import {
  ablationExperiments,
  experiments,
  experimentPromptVersions,
  prompts,
  promptVersions,
  generationRuns,
  evaluationRuns,
  type AblationExperiment,
} from "../schema.js";
import { hashPromptBlocks, stableStringify } from "../versioning.js";
import { createExperimentRepository, normalizeStartExperiment } from "./experiments.js";
import { createPromptRepository } from "./prompts.js";

export interface CreateAblationInput {
  readonly projectId: string;
  readonly sourceExperimentId: string;
  readonly candidatePromptVersionId: string;
  readonly blockId: string;
}

export interface AblationRepository {
  create(input: CreateAblationInput): Promise<AblationExperiment>;
  list(projectId: string, sourceExperimentId: string): Promise<AblationExperiment[]>;
}

export function createAblationRepository(db: RepositoryDatabase): AblationRepository {
  return {
    async list(projectId, sourceExperimentId) {
      return db
        .select({ link: ablationExperiments })
        .from(ablationExperiments)
        .innerJoin(experiments, eq(experiments.id, ablationExperiments.sourceExperimentId))
        .where(and(eq(experiments.projectId, projectId), eq(experiments.id, sourceExperimentId)))
        .orderBy(ablationExperiments.createdAt, ablationExperiments.id)
        .then((rows) => rows.map((row) => row.link));
    },
    async create(input) {
      return db.transaction(async (tx) => {
        // Serializes retries and enforces a per-source limit before any paid jobs exist.
        const [source] = await tx
          .select()
          .from(experiments)
          .where(
            and(
              eq(experiments.id, input.sourceExperimentId),
              eq(experiments.projectId, input.projectId),
            ),
          )
          .for("update")
          .limit(1);
        if (!source) throw new EntityNotFoundError("Experiment", input.sourceExperimentId);
        const links = await tx
          .select()
          .from(ablationExperiments)
          .where(eq(ablationExperiments.sourceExperimentId, source.id));
        const existing = links.find(
          (link) =>
            link.candidatePromptVersionId === input.candidatePromptVersionId &&
            link.revertedBlockId === input.blockId,
        );
        if (existing) return existing;
        if (links.length >= 5)
          throw new RepositoryConflictError(
            "ABLATION_LIMIT_REACHED",
            "At most five block interventions may be queued per source experiment.",
          );
        const versions = await tx
          .select({ version: promptVersions, isBaseline: experimentPromptVersions.isBaseline })
          .from(experimentPromptVersions)
          .innerJoin(
            promptVersions,
            eq(promptVersions.id, experimentPromptVersions.promptVersionId),
          )
          .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
          .where(
            and(
              eq(experimentPromptVersions.experimentId, source.id),
              eq(prompts.projectId, input.projectId),
            ),
          );
        const baselines = versions.filter((item) => item.isBaseline);
        const baseline = baselines[0]?.version;
        const candidate = versions.find(
          (item) => !item.isBaseline && item.version.id === input.candidatePromptVersionId,
        )?.version;
        if (
          baselines.length !== 1 ||
          !baseline ||
          !candidate ||
          baseline.promptId !== candidate.promptId
        ) {
          throw new TypeError("Select a candidate from the same Prompt as the source baseline.");
        }
        const blocks = revertPromptBlock(baseline.blocks, candidate.blocks, input.blockId);
        const runs = await tx
          .select({ generation: generationRuns, evaluation: evaluationRuns })
          .from(generationRuns)
          .innerJoin(evaluationRuns, eq(evaluationRuns.generationRunId, generationRuns.id))
          .where(and(eq(generationRuns.experimentId, source.id), eq(generationRuns.repetition, 1)));
        const selected = [baseline.id, candidate.id].map((id) =>
          runs.filter((run) => run.generation.promptVersionId === id),
        );
        if (
          selected.some(
            (items) =>
              items.length !== 1 ||
              items[0]?.generation.status !== "succeeded" ||
              items[0]?.evaluation.status !== "succeeded",
          )
        ) {
          throw new RepositoryConflictError(
            "ABLATION_SOURCE_INCOMPLETE",
            "Both source runs must have succeeded in repetition 1.",
          );
        }
        const run = selected[1]?.[0];
        if (!run) throw new Error("Candidate run disappeared");
        const evaluatorModel = run.evaluation.evaluatorConfig.model;
        if (run.generation.provider !== "openai-compatible" || typeof evaluatorModel !== "string") {
          throw new TypeError("The source provider or evaluator is not supported for replay.");
        }
        // Validate even JSON values loaded from storage; never silently discard unsupported options.
        const start = normalizeStartExperiment({
          projectId: input.projectId,
          experimentId: source.id,
          provider: "openai-compatible",
          model: run.generation.model,
          modelConfig: run.generation.modelConfig,
          evaluatorModel,
        });
        if (
          selected.some((items) =>
            items.some(
              ({ generation, evaluation }) =>
                generation.provider !== start.provider ||
                generation.model !== start.model ||
                generation.modelConfigHash !== start.modelConfigHash ||
                evaluation.evaluatorKey !== "llm-judge" ||
                evaluation.evaluatorVersion !== "1" ||
                evaluation.frameworkVersionId !== source.frameworkVersionId ||
                evaluation.evaluatorConfigHash !== start.evaluatorConfigHash ||
                stableStringify(evaluation.evaluatorConfig) !==
                  stableStringify(start.evaluatorConfig),
            ),
          )
        ) {
          throw new RepositoryConflictError(
            "ABLATION_SETTINGS_CHANGED",
            "The source snapshots cannot be replayed with identical settings.",
          );
        }
        // Lock the Prompt before content lookup/create, including across different source experiments.
        await tx
          .select({ id: prompts.id })
          .from(prompts)
          .where(eq(prompts.id, candidate.promptId))
          .for("update");
        const [sameContent] = await tx
          .select()
          .from(promptVersions)
          .where(
            and(
              eq(promptVersions.promptId, candidate.promptId),
              eq(promptVersions.contentHash, hashPromptBlocks(blocks)),
            ),
          )
          .limit(1);
        let variant = sameContent;
        const promptRepository = createPromptRepository(tx);
        if (variant && variant.status !== "published") {
          throw new RepositoryConflictError(
            "ABLATION_VARIANT_UNAVAILABLE",
            "The matching variant is draft or archived; publish it explicitly before replay.",
          );
        }
        if (!variant) {
          const draft = await promptRepository.createVersion(candidate.promptId, {
            blocks,
            parentVersionId: candidate.id,
            changeSummary: `Controlled block revert: ${input.blockId}`,
          });
          variant = await promptRepository.publishVersion(draft.id);
        }
        const experimentRepository = createExperimentRepository(tx);
        const created = await experimentRepository.create({
          projectId: input.projectId,
          datasetVersionId: source.datasetVersionId,
          frameworkVersionId: source.frameworkVersionId,
          name: `Block revert: ${input.blockId}`,
          randomSeed: source.randomSeed,
          repetitions: 1,
          promptVersions: [
            { promptVersionId: candidate.id, label: "Candidate replay", isBaseline: true },
            { promptVersionId: variant.id, label: "Block reverted", isBaseline: false },
          ],
        });
        await experimentRepository.start({
          projectId: input.projectId,
          experimentId: created.id,
          provider: start.provider,
          model: start.model,
          modelConfig: start.modelConfig,
          evaluatorModel,
        });
        const [link] = await tx
          .insert(ablationExperiments)
          .values({
            sourceExperimentId: source.id,
            candidatePromptVersionId: candidate.id,
            revertedBlockId: input.blockId,
            experimentId: created.id,
            variantPromptVersionId: variant.id,
          })
          .returning();
        if (!link) throw new Error("PostgreSQL did not return the intervention link");
        return link;
      });
    },
  };
}

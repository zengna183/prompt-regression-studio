export * from "./diagnoses.js";
export * from "./datasets.js";
export * from "./evaluation-dispatches.js";
export * from "./evaluations.js";
export * from "./experiments.js";
export * from "./frameworks.js";
export * from "./projects.js";
export * from "./prompts.js";

import type { Database } from "../client.js";
import { createDiagnosisRunRepository } from "./diagnoses.js";
import { createDatasetRepository } from "./datasets.js";
import { createEvaluationDispatchRepository } from "./evaluation-dispatches.js";
import { createEvaluationRepository } from "./evaluations.js";
import { createExperimentRepository } from "./experiments.js";
import { createFrameworkRepository } from "./frameworks.js";
import { createProjectRepository } from "./projects.js";
import { createPromptRepository } from "./prompts.js";

export function createRepositories(db: Database) {
  return Object.freeze({
    projects: createProjectRepository(db),
    prompts: createPromptRepository(db),
    frameworks: createFrameworkRepository(db),
    diagnoses: createDiagnosisRunRepository(db),
    datasets: createDatasetRepository(db),
    evaluationDispatches: createEvaluationDispatchRepository(db),
    evaluations: createEvaluationRepository(db),
    experiments: createExperimentRepository(db),
  });
}

export type Repositories = ReturnType<typeof createRepositories>;

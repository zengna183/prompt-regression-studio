export * from "./diagnoses.js";
export * from "./frameworks.js";
export * from "./projects.js";
export * from "./prompts.js";

import type { Database } from "../client.js";
import { createDiagnosisRunRepository } from "./diagnoses.js";
import { createFrameworkRepository } from "./frameworks.js";
import { createProjectRepository } from "./projects.js";
import { createPromptRepository } from "./prompts.js";

export function createRepositories(db: Database) {
  return Object.freeze({
    projects: createProjectRepository(db),
    prompts: createPromptRepository(db),
    frameworks: createFrameworkRepository(db),
    diagnoses: createDiagnosisRunRepository(db),
  });
}

export type Repositories = ReturnType<typeof createRepositories>;

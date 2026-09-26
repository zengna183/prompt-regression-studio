import type { CreateExperiment, Experiment } from "@ai-chat-eval/contracts";

export interface ExperimentService {
  create(projectId: string, input: CreateExperiment): Promise<Experiment>;
}

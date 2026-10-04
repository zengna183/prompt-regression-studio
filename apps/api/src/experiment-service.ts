import type {
  CreateExperiment,
  Experiment,
  StartExperiment,
  StartedExperiment,
} from "@ai-chat-eval/contracts";

export interface ExperimentService {
  create(projectId: string, input: CreateExperiment): Promise<Experiment>;
  start(projectId: string, experimentId: string, input: StartExperiment): Promise<StartedExperiment>;
}

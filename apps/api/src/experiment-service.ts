import type {
  CreateExperiment,
  Experiment,
  ExperimentDetail,
  StartExperiment,
  StartedExperiment,
} from "@ai-chat-eval/contracts";

export interface ExperimentService {
  list(projectId: string): Promise<Experiment[]>;
  get(projectId: string, experimentId: string): Promise<ExperimentDetail>;
  create(projectId: string, input: CreateExperiment): Promise<Experiment>;
  start(projectId: string, experimentId: string, input: StartExperiment): Promise<StartedExperiment>;
}

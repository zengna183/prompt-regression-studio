import type {
  CreateExperiment,
  Experiment,
  ExperimentComparison,
  ExperimentDetail,
  ExperimentCasePage,
  StartExperiment,
  StartedExperiment,
} from "@ai-chat-eval/contracts";

export interface ExperimentService {
  list(projectId: string): Promise<Experiment[]>;
  get(projectId: string, experimentId: string): Promise<ExperimentDetail>;
  compare(projectId: string, experimentId: string): Promise<ExperimentComparison>;
  cases(
    projectId: string,
    experimentId: string,
    query: { offset: number; limit: number; repetition: number },
  ): Promise<ExperimentCasePage>;
  create(projectId: string, input: CreateExperiment): Promise<Experiment>;
  start(
    projectId: string,
    experimentId: string,
    input: StartExperiment,
  ): Promise<StartedExperiment>;
  cancel(projectId: string, experimentId: string): Promise<Experiment>;
}

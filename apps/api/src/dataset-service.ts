import type {
  CreateDataset,
  CreateDatasetVersion,
  Dataset,
  DatasetVersion,
  EvaluationCase,
} from "@ai-chat-eval/contracts";

export interface DatasetService {
  list(projectId: string): Promise<Dataset[]>;
  create(projectId: string, input: CreateDataset): Promise<Dataset>;
  listVersions(datasetId: string): Promise<DatasetVersion[]>;
  createVersion(datasetId: string, input: CreateDatasetVersion): Promise<DatasetVersion>;
  listCases(versionId: string): Promise<EvaluationCase[]>;
  publishVersion(versionId: string): Promise<DatasetVersion>;
}

import type {
  CreateFramework,
  CreateFrameworkVersion,
  CreateProject,
  CreatePrompt,
  CreatePromptVersion,
  EvaluationFramework,
  FrameworkVersion,
  Project,
  Prompt,
  PromptVersion,
} from "@ai-chat-eval/contracts";

export interface CatalogService {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProject): Promise<Project>;

  listPrompts(projectId: string): Promise<Prompt[]>;
  createPrompt(projectId: string, input: CreatePrompt): Promise<Prompt>;
  listPromptVersions(promptId: string): Promise<PromptVersion[]>;
  createPromptVersion(promptId: string, input: CreatePromptVersion): Promise<PromptVersion>;
  publishPromptVersion(versionId: string): Promise<PromptVersion>;

  listFrameworks(projectId: string): Promise<EvaluationFramework[]>;
  createFramework(projectId: string, input: CreateFramework): Promise<EvaluationFramework>;
  listFrameworkVersions(frameworkId: string): Promise<FrameworkVersion[]>;
  createFrameworkVersion(
    frameworkId: string,
    input: CreateFrameworkVersion,
  ): Promise<FrameworkVersion>;
  publishFrameworkVersion(versionId: string): Promise<FrameworkVersion>;
}

export type ReadinessCheck = () => Promise<void>;

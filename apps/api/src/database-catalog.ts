import type {
  CreateFramework,
  CreateFrameworkVersion,
  CreateProject,
  CreatePrompt,
  CreatePromptVersion,
  EvaluationFramework as ApiFramework,
  FrameworkVersion as ApiFrameworkVersion,
  Project as ApiProject,
  Prompt as ApiPrompt,
  PromptVersion as ApiPromptVersion,
} from "@ai-chat-eval/contracts";
import {
  createFrameworkRepository,
  createProjectRepository,
  createPromptRepository,
  EntityNotFoundError,
  InvalidVersionStateError,
  RepositoryConflictError,
  VersionContentError,
  type Database,
  type EvaluationFramework,
  type EvaluationFrameworkVersion,
  type Project,
  type Prompt,
  type PromptVersion,
} from "@ai-chat-eval/db";

import type { CatalogService } from "./catalog-service.js";
import { ApiError } from "./errors.js";

function iso(value: Date): string {
  return value.toISOString();
}

function projectDto(project: Project): ApiProject {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    createdAt: iso(project.createdAt),
    updatedAt: iso(project.updatedAt),
  };
}

function promptDto(prompt: Prompt): ApiPrompt {
  return {
    id: prompt.id,
    projectId: prompt.projectId,
    key: prompt.key,
    name: prompt.name,
    description: prompt.description,
    createdAt: iso(prompt.createdAt),
    updatedAt: iso(prompt.updatedAt),
  };
}

function promptVersionDto(version: PromptVersion): ApiPromptVersion {
  return {
    id: version.id,
    promptId: version.promptId,
    version: version.version,
    status: version.status,
    blocks: version.blocks.map((block) => ({ ...block })),
    contentHash: version.contentHash,
    parentVersionId: version.parentVersionId,
    changeSummary: version.changeSummary,
    createdAt: iso(version.createdAt),
    publishedAt: version.publishedAt ? iso(version.publishedAt) : null,
  };
}

function frameworkDto(framework: EvaluationFramework): ApiFramework {
  return {
    id: framework.id,
    projectId: framework.projectId,
    key: framework.key,
    name: framework.name,
    description: framework.description,
    createdAt: iso(framework.createdAt),
    updatedAt: iso(framework.updatedAt),
  };
}

function frameworkVersionDto(version: EvaluationFrameworkVersion): ApiFrameworkVersion {
  return {
    id: version.id,
    frameworkId: version.frameworkId,
    version: version.version,
    status: version.status,
    definition: {
      levels: version.definition.levels.map((level) => ({ ...level })),
      dimensions: version.definition.dimensions.map((dimension) => ({
        ...dimension,
        scoringGuide: dimension.scoringGuide.map((guide) => ({ ...guide })),
      })),
    },
    contentHash: version.contentHash,
    parentVersionId: version.parentVersionId,
    changeSummary: version.changeSummary,
    createdAt: iso(version.createdAt),
    publishedAt: version.publishedAt ? iso(version.publishedAt) : null,
  };
}

async function fromRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EntityNotFoundError) {
      throw new ApiError(404, "NOT_FOUND", error.message);
    }
    if (error instanceof RepositoryConflictError) {
      throw new ApiError(409, error.code, error.message);
    }
    if (error instanceof InvalidVersionStateError) {
      throw new ApiError(409, "INVALID_VERSION_STATE", error.message, { status: error.status });
    }
    if (error instanceof VersionContentError) {
      throw new ApiError(422, "INVALID_CONTENT", error.message);
    }
    throw error;
  }
}

export function createDatabaseCatalog(db: Database): CatalogService {
  const projects = createProjectRepository(db);
  const prompts = createPromptRepository(db);
  const frameworks = createFrameworkRepository(db);

  return {
    async listProjects() {
      return (await fromRepository(() => projects.list())).map(projectDto);
    },
    async createProject(input: CreateProject) {
      return projectDto(
        await fromRepository(() =>
          projects.create({
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
          }),
        ),
      );
    },
    async listPrompts(projectId: string) {
      return (await fromRepository(() => prompts.listByProject(projectId))).map(promptDto);
    },
    async createPrompt(projectId: string, input: CreatePrompt) {
      return promptDto(
        await fromRepository(() =>
          prompts.create({
            projectId,
            key: input.key,
            name: input.name,
            description: input.description ?? null,
          }),
        ),
      );
    },
    async listPromptVersions(promptId: string) {
      return (await fromRepository(() => prompts.listVersions(promptId))).map(promptVersionDto);
    },
    async createPromptVersion(promptId: string, input: CreatePromptVersion) {
      return promptVersionDto(
        await fromRepository(() =>
          prompts.createVersion(promptId, {
            blocks: input.blocks,
            ...(input.parentVersionId === undefined
              ? {}
              : { parentVersionId: input.parentVersionId }),
            changeSummary: input.changeSummary ?? null,
          }),
        ),
      );
    },
    async publishPromptVersion(versionId: string) {
      return promptVersionDto(await fromRepository(() => prompts.publishVersion(versionId)));
    },
    async listFrameworks(projectId: string) {
      return (await fromRepository(() => frameworks.listByProject(projectId))).map(frameworkDto);
    },
    async createFramework(projectId: string, input: CreateFramework) {
      return frameworkDto(
        await fromRepository(() =>
          frameworks.create({
            projectId,
            key: input.key,
            name: input.name,
            description: input.description ?? null,
          }),
        ),
      );
    },
    async listFrameworkVersions(frameworkId: string) {
      return (await fromRepository(() => frameworks.listVersions(frameworkId))).map(
        frameworkVersionDto,
      );
    },
    async createFrameworkVersion(frameworkId: string, input: CreateFrameworkVersion) {
      return frameworkVersionDto(
        await fromRepository(() =>
          frameworks.createVersion(frameworkId, {
            definition: input.definition,
            ...(input.parentVersionId === undefined
              ? {}
              : { parentVersionId: input.parentVersionId }),
            changeSummary: input.changeSummary ?? null,
          }),
        ),
      );
    },
    async publishFrameworkVersion(versionId: string) {
      return frameworkVersionDto(await fromRepository(() => frameworks.publishVersion(versionId)));
    },
  };
}

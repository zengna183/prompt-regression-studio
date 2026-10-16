import { eq } from "drizzle-orm";
import type { RepositoryDatabase } from "../client.js";
import {
  datasets,
  datasetVersions,
  diagnosisRuns,
  evaluationFrameworks,
  evaluationFrameworkVersions,
  evaluationRuns,
  experiments,
  modelConnections,
  prompts,
  promptVersions,
} from "../schema.js";

export type ProjectResource =
  | "prompt"
  | "promptVersion"
  | "dataset"
  | "datasetVersion"
  | "framework"
  | "frameworkVersion"
  | "experiment"
  | "modelConnection"
  | "evaluationRun"
  | "diagnosis";
/** Only resolves ownership; callers must still check the requesting user's membership. */
export function createResourceProjectResolver(db: RepositoryDatabase) {
  return async (kind: ProjectResource, id: string): Promise<string | null> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    let rows: { projectId: string | null }[];
    switch (kind) {
      case "prompt":
        rows = await db
          .select({ projectId: prompts.projectId })
          .from(prompts)
          .where(eq(prompts.id, id));
        break;
      case "promptVersion":
        rows = await db
          .select({ projectId: prompts.projectId })
          .from(promptVersions)
          .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
          .where(eq(promptVersions.id, id));
        break;
      case "dataset":
        rows = await db
          .select({ projectId: datasets.projectId })
          .from(datasets)
          .where(eq(datasets.id, id));
        break;
      case "datasetVersion":
        rows = await db
          .select({ projectId: datasets.projectId })
          .from(datasetVersions)
          .innerJoin(datasets, eq(datasets.id, datasetVersions.datasetId))
          .where(eq(datasetVersions.id, id));
        break;
      case "framework":
        rows = await db
          .select({ projectId: evaluationFrameworks.projectId })
          .from(evaluationFrameworks)
          .where(eq(evaluationFrameworks.id, id));
        break;
      case "frameworkVersion":
        rows = await db
          .select({ projectId: evaluationFrameworks.projectId })
          .from(evaluationFrameworkVersions)
          .innerJoin(
            evaluationFrameworks,
            eq(evaluationFrameworks.id, evaluationFrameworkVersions.frameworkId),
          )
          .where(eq(evaluationFrameworkVersions.id, id));
        break;
      case "experiment":
        rows = await db
          .select({ projectId: experiments.projectId })
          .from(experiments)
          .where(eq(experiments.id, id));
        break;
      case "modelConnection":
        rows = await db
          .select({ projectId: modelConnections.projectId })
          .from(modelConnections)
          .where(eq(modelConnections.id, id));
        break;
      case "evaluationRun":
        rows = await db
          .select({ projectId: experiments.projectId })
          .from(evaluationRuns)
          .innerJoin(experiments, eq(experiments.id, evaluationRuns.experimentId))
          .where(eq(evaluationRuns.id, id));
        break;
      case "diagnosis":
        rows = await db
          .select({ projectId: diagnosisRuns.projectId })
          .from(diagnosisRuns)
          .where(eq(diagnosisRuns.id, id));
        break;
    }
    return rows[0]?.projectId ?? null;
  };
}

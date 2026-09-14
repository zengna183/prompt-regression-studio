import { DiagnosisEngineError, type JsonObject } from "@prompt-regression/diagnosis-engine";
import {
  createDiagnosisRunRepository,
  type Database,
  type DiagnosisRun,
  type JsonValue as DatabaseJsonValue,
} from "@ai-chat-eval/db";

import type { DiagnosisRunDetail, DiagnosisRunSummary, DiagnosisStore } from "./diagnosis-store.js";

export function createDatabaseDiagnosisStore(db: Database): DiagnosisStore {
  const repository = createDiagnosisRunRepository(db);
  return {
    async begin(bundleId, bundle) {
      return summary(
        await repository.begin({
          bundleId,
          inputBundle: asDatabaseJson(bundle),
        }),
      );
    },

    async complete(id, report) {
      const identity = readReportIdentity(report);
      return detail(
        await repository.complete(id, {
          inputBundleHash: identity.inputBundleHash,
          reportId: identity.reportId,
          report: asDatabaseJson(report),
        }),
      );
    },

    async fail(id, code, message, cancelled) {
      return detail(
        await repository.fail(id, {
          status: cancelled ? "cancelled" : "failed",
          failureCode: code,
          failureMessage: message,
        }),
      );
    },

    async get(id) {
      const run = await repository.getById(id);
      return run ? detail(run) : null;
    },

    async list(input) {
      const runs = await repository.list(input);
      return runs.map(summary);
    },
  };
}

function summary(run: DiagnosisRun): DiagnosisRunSummary {
  return {
    id: run.id,
    projectId: run.projectId,
    bundleId: run.bundleId,
    status: run.status,
    inputBundleHash: run.inputBundleHash,
    reportId: run.reportId,
    failureCode: run.failureCode,
    failureMessage: run.failureMessage,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function detail(run: DiagnosisRun): DiagnosisRunDetail {
  return {
    ...summary(run),
    report: toJsonObject(run.report),
  };
}

function readReportIdentity(
  report: JsonObject,
): Readonly<{ reportId: string; inputBundleHash: string }> {
  const reportId = report.report_id;
  const inputBundleHash = report.input_bundle_hash;
  if (typeof reportId !== "string" || typeof inputBundleHash !== "string") {
    throw new DiagnosisEngineError(
      "DIAGNOSIS_ENGINE_INVALID_OUTPUT",
      "Diagnosis report is missing its persistence identity",
    );
  }
  return { reportId, inputBundleHash };
}

function asDatabaseJson(value: JsonObject): DatabaseJsonValue {
  return value as unknown as DatabaseJsonValue;
}

function toJsonObject(value: DatabaseJsonValue | null): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

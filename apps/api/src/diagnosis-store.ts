import type { DiagnosisEngineErrorCode, JsonObject } from "@prompt-regression/diagnosis-engine";

export type StoredDiagnosisStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface DiagnosisRunSummary {
  readonly id: string;
  readonly projectId: string | null;
  readonly bundleId: string;
  readonly status: StoredDiagnosisStatus;
  readonly inputBundleHash: string | null;
  readonly reportId: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface DiagnosisRunDetail extends DiagnosisRunSummary {
  readonly report: JsonObject | null;
}

export interface ListDiagnosisRunsInput {
  readonly projectId?: string;
  readonly status?: StoredDiagnosisStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface DiagnosisStore {
  begin(bundleId: string, bundle: JsonObject): Promise<DiagnosisRunSummary>;
  complete(id: string, report: JsonObject): Promise<DiagnosisRunDetail>;
  fail(
    id: string,
    code: DiagnosisEngineErrorCode | "INTERNAL_ERROR",
    message: string,
    cancelled: boolean,
  ): Promise<DiagnosisRunDetail>;
  get(id: string): Promise<DiagnosisRunDetail | null>;
  list(input: ListDiagnosisRunsInput): Promise<readonly DiagnosisRunSummary[]>;
}

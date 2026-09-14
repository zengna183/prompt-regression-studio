import { and, desc, eq, type SQL } from "drizzle-orm";

import type { Database } from "../client.js";
import { EntityNotFoundError, RepositoryConflictError } from "../errors.js";
import { diagnosisRuns, type DiagnosisRun, type JsonValue } from "../schema.js";

export type DiagnosisTerminalStatus = "failed" | "cancelled";

export interface BeginDiagnosisRunInput {
  readonly projectId?: string | null;
  readonly bundleId: string;
  readonly inputBundle: JsonValue;
}

export interface CompleteDiagnosisRunInput {
  readonly inputBundleHash: string;
  readonly reportId: string;
  readonly report: JsonValue;
}

export interface FailDiagnosisRunInput {
  readonly status: DiagnosisTerminalStatus;
  readonly failureCode: string;
  readonly failureMessage: string;
}

export interface ListDiagnosisRunsOptions {
  readonly projectId?: string;
  readonly status?: DiagnosisRun["status"];
  readonly limit?: number;
  readonly offset?: number;
}

export interface DiagnosisRunRepository {
  begin(input: BeginDiagnosisRunInput): Promise<DiagnosisRun>;
  complete(id: string, input: CompleteDiagnosisRunInput): Promise<DiagnosisRun>;
  fail(id: string, input: FailDiagnosisRunInput): Promise<DiagnosisRun>;
  getById(id: string): Promise<DiagnosisRun | null>;
  list(options?: ListDiagnosisRunsOptions): Promise<DiagnosisRun[]>;
}

const safeIdentifier = /^[^\s]+$/u;
const sha256 = /^[0-9a-f]{64}$/u;
const failureCodePattern = /^[A-Z0-9_]+$/u;

export function normalizeDiagnosisBundleId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 256 || !safeIdentifier.test(normalized)) {
    throw new TypeError("bundleId must be 1-256 characters without whitespace");
  }
  return normalized;
}

export function normalizeDiagnosisHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!sha256.test(normalized)) throw new TypeError("inputBundleHash must be a SHA-256 hex digest");
  return normalized;
}

export function normalizeDiagnosisReportId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 256 || !safeIdentifier.test(normalized)) {
    throw new TypeError("reportId must be 1-256 characters without whitespace");
  }
  return normalized;
}

export function normalizeDiagnosisFailure(
  code: string,
  message: string,
): Readonly<{ code: string; message: string }> {
  const normalizedCode = code.trim().toUpperCase();
  const normalizedMessage = message.trim();
  if (
    normalizedCode.length < 1 ||
    normalizedCode.length > 120 ||
    !failureCodePattern.test(normalizedCode)
  ) {
    throw new TypeError(
      "failureCode must contain only uppercase letters, numbers, and underscores",
    );
  }
  if (normalizedMessage.length < 1 || normalizedMessage.length > 2_000) {
    throw new TypeError("failureMessage must be 1-2000 characters");
  }
  return Object.freeze({ code: normalizedCode, message: normalizedMessage });
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new TypeError("limit must be an integer from 1 to 200");
  }
  return value;
}

function pageOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("offset must be a non-negative integer");
  }
  return value;
}

export function createDiagnosisRunRepository(db: Database): DiagnosisRunRepository {
  return {
    async begin(input) {
      const [created] = await db
        .insert(diagnosisRuns)
        .values({
          projectId: input.projectId ?? null,
          bundleId: normalizeDiagnosisBundleId(input.bundleId),
          inputBundle: input.inputBundle,
          status: "running",
        })
        .returning();
      if (!created) throw new Error("PostgreSQL did not return the created diagnosis run");
      return created;
    },

    async complete(id, input) {
      const now = new Date();
      const [completed] = await db
        .update(diagnosisRuns)
        .set({
          status: "succeeded",
          inputBundleHash: normalizeDiagnosisHash(input.inputBundleHash),
          reportId: normalizeDiagnosisReportId(input.reportId),
          report: input.report,
          failureCode: null,
          failureMessage: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(diagnosisRuns.id, id), eq(diagnosisRuns.status, "running")))
        .returning();
      if (completed) return completed;
      return throwMissingOrTerminal(db, id);
    },

    async fail(id, input) {
      const failure = normalizeDiagnosisFailure(input.failureCode, input.failureMessage);
      const now = new Date();
      const [failed] = await db
        .update(diagnosisRuns)
        .set({
          status: input.status,
          failureCode: failure.code,
          failureMessage: failure.message,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(diagnosisRuns.id, id), eq(diagnosisRuns.status, "running")))
        .returning();
      if (failed) return failed;
      return throwMissingOrTerminal(db, id);
    },

    async getById(id) {
      const [run] = await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.id, id)).limit(1);
      return run ?? null;
    },

    async list(options = {}) {
      const conditions: SQL[] = [];
      if (options.projectId !== undefined) {
        conditions.push(eq(diagnosisRuns.projectId, options.projectId));
      }
      if (options.status !== undefined) {
        conditions.push(eq(diagnosisRuns.status, options.status));
      }

      const query = db
        .select()
        .from(diagnosisRuns)
        .orderBy(desc(diagnosisRuns.createdAt), desc(diagnosisRuns.id))
        .limit(pageLimit(options.limit))
        .offset(pageOffset(options.offset));

      return conditions.length > 0 ? query.where(and(...conditions)) : query;
    },
  };
}

async function throwMissingOrTerminal(db: Database, id: string): Promise<never> {
  const [existing] = await db
    .select({ status: diagnosisRuns.status })
    .from(diagnosisRuns)
    .where(eq(diagnosisRuns.id, id))
    .limit(1);
  if (!existing) throw new EntityNotFoundError("DiagnosisRun", id);
  throw new RepositoryConflictError(
    "DIAGNOSIS_RUN_TERMINAL",
    `Diagnosis run ${id} is already ${existing.status}`,
  );
}

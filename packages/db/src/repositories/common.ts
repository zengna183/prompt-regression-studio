import { RepositoryConflictError } from "../errors.js";

const keyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeKey(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 2 || normalized.length > 64 || !keyPattern.test(normalized)) {
    throw new TypeError(`${label} must be 2-64 lowercase letters, numbers, or single hyphens`);
  }
  return normalized;
}

export function normalizeName(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > 120) {
    throw new TypeError(`${label} must be 2-120 characters`);
  }
  return normalized;
}

export function normalizeDescription(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length > 1_000) throw new TypeError("description must be at most 1000 characters");
  return normalized === "" ? null : normalized;
}

export function normalizeChangeSummary(value: string | null | undefined): string | null {
  return normalizeDescription(value);
}

interface PostgreSqlErrorLike {
  readonly code?: unknown;
  readonly constraint_name?: unknown;
  readonly constraint?: unknown;
}

export function mapUniqueViolation(error: unknown, code: string, message: string): never {
  if (typeof error === "object" && error !== null) {
    const candidate = error as PostgreSqlErrorLike;
    if (candidate.code === "23505") throw new RepositoryConflictError(code, message);
  }
  throw error;
}

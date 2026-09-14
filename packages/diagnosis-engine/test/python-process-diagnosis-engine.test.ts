import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DiagnosisEngineError,
  PythonProcessDiagnosisEngine,
  type JsonObject,
} from "../src/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/diagnosis-process.mjs", import.meta.url));
const originalParentSecret = process.env.DIAGNOSIS_ENGINE_PARENT_SECRET;

afterEach(() => {
  if (originalParentSecret === undefined) {
    delete process.env.DIAGNOSIS_ENGINE_PARENT_SECRET;
  } else {
    process.env.DIAGNOSIS_ENGINE_PARENT_SECRET = originalParentSecret;
  }
});

describe("PythonProcessDiagnosisEngine", () => {
  it("writes the bundle to stdin and parses a compact JSON report", async () => {
    const engine = fixtureEngine("success");
    const bundle = { schema_version: "v1alpha1", bundle_id: "bundle-1" } as const;

    await expect(engine.diagnose(bundle)).resolves.toEqual({
      kind: "DiagnosisReport",
      received: bundle,
    });
  });

  it("uses a minimal inherited environment plus explicit overrides by default", async () => {
    process.env.DIAGNOSIS_ENGINE_PARENT_SECRET = "must-not-cross-boundary";
    const engine = fixtureEngine("environment", {
      environment: { DIAGNOSIS_ENGINE_EXPLICIT: "configured" },
    });

    await expect(engine.diagnose({ bundle_id: "bundle-1" })).resolves.toEqual({
      kind: "DiagnosisReport",
      explicitValue: "configured",
      inheritedSecret: null,
    });
  });

  it("maps a non-zero exit to a safe stable error without leaking stderr", async () => {
    const error = await captureError(fixtureEngine("nonzero").diagnose({ bundle_id: "bundle-1" }));

    expect(error.code).toBe("DIAGNOSIS_ENGINE_PROCESS_FAILED");
    expect(error.message).not.toContain("super-secret");
    expect(JSON.stringify(error)).not.toContain("super-secret");
    expect(error.getDiagnosticForOperatorLogging()).toContain("super-secret");
  });

  it("maps Core exit code 2 to a non-retryable invalid-input error", async () => {
    const error = await captureError(
      fixtureEngine("invalid-input").diagnose({ bundle_id: "invalid" }),
    );

    expect(error.code).toBe("DIAGNOSIS_ENGINE_INVALID_INPUT");
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain("sensitive-invalid-bundle-detail");
    expect(JSON.stringify(error)).not.toContain("sensitive-invalid-bundle-detail");
  });

  it("terminates a process that exceeds its timeout", async () => {
    const engine = fixtureEngine("hang", { timeoutMs: 40 });

    const error = await captureError(engine.diagnose({ bundle_id: "bundle-1" }));
    expect(error.code).toBe("DIAGNOSIS_ENGINE_TIMEOUT");
  });

  it("rejects an oversized input before starting a process", async () => {
    const engine = fixtureEngine("success", { maxInputBytes: 16 });

    const error = await captureError(
      engine.diagnose({ bundle_id: "bundle-1", content: "x".repeat(100) }),
    );
    expect(error.code).toBe("DIAGNOSIS_ENGINE_INPUT_TOO_LARGE");
  });

  it("validates an unknown transport payload before starting a process", async () => {
    const engine = fixtureEngine("success");

    const error = await captureError(engine.diagnose(["not", "an", "object"]));
    expect(error.code).toBe("DIAGNOSIS_ENGINE_INVALID_INPUT");
  });

  it("terminates a process that exceeds the stdout limit", async () => {
    const engine = fixtureEngine("large-output", { maxOutputBytes: 64 });

    const error = await captureError(engine.diagnose({ bundle_id: "bundle-1" }));
    expect(error.code).toBe("DIAGNOSIS_ENGINE_OUTPUT_TOO_LARGE");
  });

  it("terminates a process that exceeds the stderr limit", async () => {
    const engine = fixtureEngine("large-stderr", { maxStderrBytes: 64 });

    const error = await captureError(engine.diagnose({ bundle_id: "bundle-1" }));
    expect(error.code).toBe("DIAGNOSIS_ENGINE_STDERR_TOO_LARGE");
    expect(error.message).not.toContain("sensitive");
  });

  it("rejects successful process output that is not a JSON object", async () => {
    const error = await captureError(
      fixtureEngine("invalid-json").diagnose({ bundle_id: "bundle-1" }),
    );

    expect(error.code).toBe("DIAGNOSIS_ENGINE_INVALID_OUTPUT");
  });

  it("terminates the process when its AbortSignal is aborted", async () => {
    const controller = new AbortController();
    const pending = fixtureEngine("hang", { timeoutMs: 5_000 }).diagnose(
      { bundle_id: "bundle-1" },
      { signal: controller.signal },
    );

    setTimeout(() => controller.abort(), 30);

    const error = await captureError(pending);
    expect(error.code).toBe("DIAGNOSIS_ENGINE_ABORTED");
  });

  it("does not start a process for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await captureError(
      fixtureEngine("success").diagnose({ bundle_id: "bundle-1" }, { signal: controller.signal }),
    );
    expect(error.code).toBe("DIAGNOSIS_ENGINE_ABORTED");
  });

  it("maps an unavailable executable to a stable start error", async () => {
    const engine = new PythonProcessDiagnosisEngine({
      executable: fileURLToPath(new URL("./fixtures/does-not-exist", import.meta.url)),
      moduleArgs: [],
      timeoutMs: 1_000,
    });

    const error = await captureError(engine.diagnose({ bundle_id: "bundle-1" }));
    expect(error.code).toBe("DIAGNOSIS_ENGINE_START_FAILED");
  });
});

interface FixtureOverrides {
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxStderrBytes?: number;
}

function fixtureEngine(
  mode: string,
  overrides: FixtureOverrides = {},
): PythonProcessDiagnosisEngine<JsonObject> {
  return new PythonProcessDiagnosisEngine({
    executable: process.execPath,
    moduleArgs: [fixturePath, mode],
    timeoutMs: overrides.timeoutMs ?? 2_000,
    maxInputBytes: overrides.maxInputBytes ?? 64 * 1024,
    maxOutputBytes: overrides.maxOutputBytes ?? 64 * 1024,
    maxStderrBytes: overrides.maxStderrBytes ?? 64 * 1024,
    ...(overrides.environment === undefined ? {} : { environment: overrides.environment }),
  });
}

async function captureError(promise: Promise<unknown>): Promise<DiagnosisEngineError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DiagnosisEngineError);
    return error as DiagnosisEngineError;
  }
  throw new Error("Expected the promise to reject.");
}

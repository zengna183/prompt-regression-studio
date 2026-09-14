import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { DiagnosisEngineError } from "./errors.js";
import type { DiagnosisEngine, DiagnosisOptions, JsonObject } from "./types.js";

const CORE_COMMAND_ARGUMENTS = ["diagnose", "-", "--compact"] as const;
const DEFAULT_MODULE_ARGUMENTS = ["-m", "prompt_regression_core"] as const;

const MINIMAL_ENVIRONMENT_KEYS = new Set([
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "WINDIR",
]);

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_INPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const TERMINATION_GRACE_MS = 1_000;

export type ProcessEnvironmentPolicy = "minimal" | "inherit";

export interface PythonProcessDiagnosisEngineConfig {
  /** Operator-controlled executable. It cannot be overridden per request. */
  readonly executable: string;
  /** Operator-controlled arguments placed before the fixed Core command. */
  readonly moduleArgs?: readonly string[];
  readonly cwd?: string;
  readonly environmentPolicy?: ProcessEnvironmentPolicy;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxStderrBytes?: number;
}

interface ProcessLimits {
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxStderrBytes: number;
}

/**
 * Runs the Python reference Core as a constrained child process.
 *
 * The command boundary is intentionally fixed at construction time. Request
 * data is sent only through stdin and is never interpolated into arguments.
 */
export class PythonProcessDiagnosisEngine<
  TReport extends JsonObject = JsonObject,
> implements DiagnosisEngine<TReport> {
  readonly #executable: string;
  readonly #moduleArgs: readonly string[];
  readonly #cwd: string | undefined;
  readonly #environmentPolicy: ProcessEnvironmentPolicy;
  readonly #environmentOverrides: Readonly<Record<string, string>>;
  readonly #limits: ProcessLimits;

  constructor(config: PythonProcessDiagnosisEngineConfig) {
    this.#executable = validateText(config.executable, "executable");
    this.#moduleArgs = Object.freeze(
      (config.moduleArgs ?? DEFAULT_MODULE_ARGUMENTS).map((argument, index) =>
        validateArgument(argument, `moduleArgs[${String(index)}]`),
      ),
    );
    this.#cwd = config.cwd === undefined ? undefined : validateText(config.cwd, "cwd");
    this.#environmentPolicy = config.environmentPolicy ?? "minimal";

    if (this.#environmentPolicy !== "minimal" && this.#environmentPolicy !== "inherit") {
      throw invalidConfiguration("environmentPolicy must be either 'minimal' or 'inherit'.");
    }

    this.#environmentOverrides = Object.freeze(validateEnvironment(config.environment ?? {}));
    this.#limits = Object.freeze({
      timeoutMs: validateTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      maxInputBytes: validateLimit(
        config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
        "maxInputBytes",
      ),
      maxOutputBytes: validateLimit(
        config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        "maxOutputBytes",
      ),
      maxStderrBytes: validateLimit(
        config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
        "maxStderrBytes",
      ),
    });
  }

  async diagnose(bundle: unknown, options: DiagnosisOptions = {}): Promise<TReport> {
    if (options.signal?.aborted === true) {
      throw abortedError();
    }

    const input = serializeBundle(bundle);
    if (input.byteLength > this.#limits.maxInputBytes) {
      throw new DiagnosisEngineError(
        "DIAGNOSIS_ENGINE_INPUT_TOO_LARGE",
        "The diagnosis bundle exceeds the configured input limit.",
      );
    }

    const spawnOptions: SpawnOptionsWithoutStdio = {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.#buildEnvironment(),
    };
    if (this.#cwd !== undefined) {
      spawnOptions.cwd = this.#cwd;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.#executable,
        [...this.#moduleArgs, ...CORE_COMMAND_ARGUMENTS],
        spawnOptions,
      );
    } catch (error) {
      throw startFailedError(error);
    }

    return await this.#exchange(child, input, options.signal);
  }

  #buildEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};

    for (const [key, value] of Object.entries(process.env)) {
      const include =
        this.#environmentPolicy === "inherit" || MINIMAL_ENVIRONMENT_KEYS.has(key.toUpperCase());
      if (include && value !== undefined) {
        environment[key] = value;
      }
    }

    for (const [key, value] of Object.entries(this.#environmentOverrides)) {
      environment[key] = value;
    }

    return environment;
  }

  async #exchange(
    child: ChildProcessWithoutNullStreams,
    input: Buffer,
    signal: AbortSignal | undefined,
  ): Promise<TReport> {
    return await new Promise<TReport>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let forcedError: DiagnosisEngineError | undefined;
      let settled = false;
      let terminationTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        clearTimeout(timer);
        if (terminationTimer !== undefined) clearTimeout(terminationTimer);
        signal?.removeEventListener("abort", onAbort);
      };

      const rejectOnce = (error: DiagnosisEngineError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const resolveOnce = (report: TReport): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(report);
      };

      const terminate = (error: DiagnosisEngineError): void => {
        if (settled) return;
        if (forcedError === undefined) forcedError = error;
        try {
          const signalSent = child.kill("SIGKILL");
          if (!signalSent) {
            detachChild(child);
            rejectOnce(forcedError);
            return;
          }
          terminationTimer ??= setTimeout(() => {
            detachChild(child);
            rejectOnce(forcedError ?? error);
          }, TERMINATION_GRACE_MS);
          terminationTimer.unref();
        } catch {
          detachChild(child);
          rejectOnce(forcedError);
        }
      };

      const onAbort = (): void => {
        terminate(abortedError());
      };

      const timer = setTimeout(() => {
        terminate(
          new DiagnosisEngineError(
            "DIAGNOSIS_ENGINE_TIMEOUT",
            "The diagnosis process exceeded the configured time limit.",
            { retryable: true },
          ),
        );
      }, this.#limits.timeoutMs);
      timer.unref();

      child.stdout.on("data", (chunk: Buffer | string) => {
        const buffer = toBuffer(chunk);
        stdoutBytes += buffer.byteLength;
        if (stdoutBytes > this.#limits.maxOutputBytes) {
          terminate(
            new DiagnosisEngineError(
              "DIAGNOSIS_ENGINE_OUTPUT_TOO_LARGE",
              "The diagnosis report exceeds the configured output limit.",
            ),
          );
          return;
        }
        stdoutChunks.push(buffer);
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        const buffer = toBuffer(chunk);
        const remaining = this.#limits.maxStderrBytes - stderrBytes;
        if (remaining > 0) stderrChunks.push(buffer.subarray(0, remaining));
        stderrBytes += buffer.byteLength;
        if (stderrBytes > this.#limits.maxStderrBytes) {
          terminate(
            new DiagnosisEngineError(
              "DIAGNOSIS_ENGINE_STDERR_TOO_LARGE",
              "The diagnosis process exceeded the configured diagnostic output limit.",
              {
                operatorDiagnostic: sanitizeDiagnostic(Buffer.concat(stderrChunks)),
              },
            ),
          );
        }
      });

      const onStreamError = (error: unknown): void => {
        terminate(
          new DiagnosisEngineError(
            "DIAGNOSIS_ENGINE_IO_FAILED",
            "Communication with the diagnosis process failed.",
            { retryable: true, operatorDiagnostic: describeUnknownError(error) },
          ),
        );
      };
      child.stdin.on("error", onStreamError);
      child.stdout.on("error", onStreamError);
      child.stderr.on("error", onStreamError);

      child.once("error", (error) => {
        rejectOnce(forcedError ?? startFailedError(error));
      });

      child.once("close", (code, closeSignal) => {
        if (forcedError !== undefined) {
          rejectOnce(forcedError);
          return;
        }

        if (code !== 0) {
          const stderr = sanitizeDiagnostic(Buffer.concat(stderrChunks));
          if (code === 2) {
            rejectOnce(
              new DiagnosisEngineError(
                "DIAGNOSIS_ENGINE_INVALID_INPUT",
                "The diagnosis bundle was rejected by the diagnosis Core.",
                {
                  operatorDiagnostic: buildExitDiagnostic(code, closeSignal, stderr),
                },
              ),
            );
            return;
          }
          rejectOnce(
            new DiagnosisEngineError(
              "DIAGNOSIS_ENGINE_PROCESS_FAILED",
              "The diagnosis process exited unsuccessfully.",
              {
                retryable: true,
                operatorDiagnostic: buildExitDiagnostic(code, closeSignal, stderr),
              },
            ),
          );
          return;
        }

        const output = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
        try {
          const parsed = JSON.parse(output) as unknown;
          if (!isJsonObject(parsed)) {
            throw new TypeError("The process output is not a JSON object.");
          }
          resolveOnce(parsed as TReport);
        } catch (error) {
          rejectOnce(
            new DiagnosisEngineError(
              "DIAGNOSIS_ENGINE_INVALID_OUTPUT",
              "The diagnosis process returned an invalid report.",
              { operatorDiagnostic: describeUnknownError(error) },
            ),
          );
        }
      });

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }

      try {
        child.stdin.end(input);
      } catch (error) {
        onStreamError(error);
      }
    });
  }
}

function serializeBundle(bundle: unknown): Buffer {
  if (!isJsonObject(bundle)) {
    throw new DiagnosisEngineError(
      "DIAGNOSIS_ENGINE_INVALID_INPUT",
      "The diagnosis bundle must be a JSON object.",
    );
  }

  try {
    const serialized = JSON.stringify(bundle);
    if (typeof serialized !== "string") {
      throw new TypeError("The bundle cannot be represented as JSON.");
    }
    return Buffer.from(`${serialized}\n`, "utf8");
  } catch (error) {
    throw new DiagnosisEngineError(
      "DIAGNOSIS_ENGINE_INVALID_INPUT",
      "The diagnosis bundle cannot be serialized as JSON.",
      { operatorDiagnostic: describeUnknownError(error) },
    );
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateText(value: string, name: string): string {
  if (value.trim().length === 0 || value.includes("\0")) {
    throw invalidConfiguration(`${name} must be a non-empty string without null bytes.`);
  }
  return value;
}

function validateArgument(value: string, name: string): string {
  if (value.includes("\0")) {
    throw invalidConfiguration(`${name} must not contain null bytes.`);
  }
  return value;
}

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidConfiguration(`${name} must be a positive safe integer.`);
  }
  return value;
}

function validateTimeout(value: number): number {
  const timeout = validateLimit(value, "timeoutMs");
  if (timeout > MAX_NODE_TIMER_DELAY_MS) {
    throw invalidConfiguration(
      `timeoutMs must be no greater than ${String(MAX_NODE_TIMER_DELAY_MS)}.`,
    );
  }
  return timeout;
}

function validateEnvironment(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0") || value.includes("\0")) {
      throw invalidConfiguration("Environment names and values must be valid process strings.");
    }
    result[key] = value;
  }
  return result;
}

function invalidConfiguration(diagnostic: string): DiagnosisEngineError {
  return new DiagnosisEngineError(
    "DIAGNOSIS_ENGINE_INVALID_CONFIGURATION",
    "The diagnosis engine configuration is invalid.",
    { operatorDiagnostic: diagnostic },
  );
}

function abortedError(): DiagnosisEngineError {
  return new DiagnosisEngineError(
    "DIAGNOSIS_ENGINE_ABORTED",
    "The diagnosis request was cancelled.",
  );
}

function startFailedError(error: unknown): DiagnosisEngineError {
  return new DiagnosisEngineError(
    "DIAGNOSIS_ENGINE_START_FAILED",
    "The diagnosis process could not be started.",
    { retryable: true, operatorDiagnostic: describeUnknownError(error) },
  );
}

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
}

function detachChild(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}

function buildExitDiagnostic(
  code: number | null,
  closeSignal: NodeJS.Signals | null,
  stderr: string,
): string {
  const status = `exitCode=${code === null ? "null" : String(code)}, signal=${closeSignal ?? "none"}`;
  return stderr.length === 0 ? status : `${status}\nstderr:\n${stderr}`;
}

function sanitizeDiagnostic(buffer: Buffer): string {
  const decoded = buffer.toString("utf8");
  let sanitized = "";
  for (const character of decoded) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32) {
      sanitized += character;
    } else {
      sanitized += "�";
    }
  }
  return sanitized;
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "Unknown process error.";
}

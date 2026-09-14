export const diagnosisEngineErrorCodes = [
  "DIAGNOSIS_ENGINE_INVALID_CONFIGURATION",
  "DIAGNOSIS_ENGINE_INVALID_INPUT",
  "DIAGNOSIS_ENGINE_INPUT_TOO_LARGE",
  "DIAGNOSIS_ENGINE_OUTPUT_TOO_LARGE",
  "DIAGNOSIS_ENGINE_STDERR_TOO_LARGE",
  "DIAGNOSIS_ENGINE_TIMEOUT",
  "DIAGNOSIS_ENGINE_ABORTED",
  "DIAGNOSIS_ENGINE_START_FAILED",
  "DIAGNOSIS_ENGINE_PROCESS_FAILED",
  "DIAGNOSIS_ENGINE_IO_FAILED",
  "DIAGNOSIS_ENGINE_INVALID_OUTPUT",
] as const;

export type DiagnosisEngineErrorCode = (typeof diagnosisEngineErrorCodes)[number];

interface DiagnosisEngineErrorOptions {
  readonly retryable?: boolean;
  readonly operatorDiagnostic?: string;
}

/** A stable, transport-safe failure returned by a diagnosis engine adapter. */
export class DiagnosisEngineError extends Error {
  override readonly name: string = "DiagnosisEngineError";
  readonly code: DiagnosisEngineErrorCode;
  readonly retryable: boolean;
  readonly #operatorDiagnostic: string | undefined;

  constructor(
    code: DiagnosisEngineErrorCode,
    message: string,
    options: DiagnosisEngineErrorOptions = {},
  ) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.#operatorDiagnostic = options.operatorDiagnostic;
  }

  /**
   * Returns bounded process diagnostics for trusted operational logs only.
   * Never return this value in an API response or expose it to an end user.
   */
  getDiagnosticForOperatorLogging(): string | undefined {
    return this.#operatorDiagnostic;
  }

  /** Deliberately excludes stderr and other process diagnostics. */
  toJSON(): Readonly<{
    name: string;
    code: DiagnosisEngineErrorCode;
    message: string;
    retryable: boolean;
  }> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function isDiagnosisEngineError(value: unknown): value is DiagnosisEngineError {
  return value instanceof DiagnosisEngineError;
}

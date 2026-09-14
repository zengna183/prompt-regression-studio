export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface DiagnosisOptions {
  readonly signal?: AbortSignal;
}

/**
 * Application-facing port for a diagnosis engine.
 *
 * Concrete bundle/report contracts remain language-neutral JSON documents. A
 * consumer may narrow both generic parameters to generated contract types.
 */
export interface DiagnosisEngine<TReport extends JsonObject = JsonObject> {
  /** Accepts an untrusted transport payload and validates it at the adapter boundary. */
  diagnose(bundle: unknown, options?: DiagnosisOptions): Promise<TReport>;
}

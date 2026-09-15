import type { IncomingMessage } from "node:http";

import type { DiagnosisEngineErrorCode } from "@prompt-regression/diagnosis-engine";
import { DiagnosisEngineError, type DiagnosisEngine } from "@prompt-regression/diagnosis-engine";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { ApiError } from "../errors.js";
import type { DiagnosisStore } from "../diagnosis-store.js";

const CanonicalBundleEnvelopeSchema = Type.Object(
  {
    schema_version: Type.Literal("prompt-regression.bundle/v1alpha1"),
    bundle_id: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\s]+$" }),
  },
  {
    additionalProperties: true,
    description:
      "Canonical Prompt Regression Bundle. The Python Core validates the complete versioned contract.",
  },
);

export interface DiagnosisRouteOptions {
  readonly engine: DiagnosisEngine;
  readonly store?: DiagnosisStore;
  readonly maxConcurrentDiagnoses: number;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
}

const DiagnosisStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

const ListDiagnosesQuerySchema = Type.Object(
  {
    projectId: Type.Optional(Type.String({ format: "uuid" })),
    status: Type.Optional(DiagnosisStatusSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  },
  { additionalProperties: false },
);

export function diagnosisRoutes(options: DiagnosisRouteOptions): FastifyPluginAsyncTypebox {
  validateConcurrency(options.maxConcurrentDiagnoses);
  validatePositiveInteger(options.rateLimitMax, "rateLimitMax");
  validatePositiveInteger(options.rateLimitWindowMs, "rateLimitWindowMs");
  let activeDiagnoses = 0;

  return (app) => {
    app.post(
      "/v1/diagnoses",
      {
        config: {
          rateLimit: {
            max: options.rateLimitMax,
            timeWindow: options.rateLimitWindowMs,
          },
        },
        schema: {
          tags: ["diagnoses"],
          summary: "Diagnose a canonical baseline-to-candidate prompt regression bundle",
          body: CanonicalBundleEnvelopeSchema,
        },
      },
      async (request, reply) => {
        if (activeDiagnoses >= options.maxConcurrentDiagnoses) {
          throw new ApiError(
            503,
            "DIAGNOSIS_CAPACITY_EXCEEDED",
            "The diagnosis service is at capacity. Try again later.",
          );
        }

        activeDiagnoses += 1;
        const requestAbort = createRequestAbortSignal(request.raw);
        let persistedRunId: string | undefined;
        try {
          if (options.store) {
            const persisted = await options.store.begin(request.body.bundle_id, request.body);
            persistedRunId = persisted.id;
          }

          const report = await options.engine.diagnose(request.body, {
            signal: requestAbort.signal,
          });
          if (options.store && persistedRunId) {
            await options.store.complete(persistedRunId, report);
            void reply.header("location", `/v1/diagnoses/${encodeURIComponent(persistedRunId)}`);
            void reply.header("x-diagnosis-run-id", persistedRunId);
          }
          return report;
        } catch (error) {
          if (options.store && persistedRunId) {
            const publicFailure = persistenceFailure(error);
            try {
              await options.store.fail(
                persistedRunId,
                publicFailure.code,
                publicFailure.message,
                publicFailure.cancelled,
              );
            } catch (persistenceError) {
              request.log.error(
                { err: persistenceError, diagnosisRunId: persistedRunId },
                "failed to persist diagnosis terminal state",
              );
            }
          }
          if (error instanceof DiagnosisEngineError) throw mapEngineError(error.code);
          throw error;
        } finally {
          requestAbort.dispose();
          activeDiagnoses -= 1;
        }
      },
    );

    const store = options.store;
    if (store) {
      app.get(
        "/v1/diagnoses",
        {
          schema: {
            tags: ["diagnoses"],
            summary: "List durable diagnosis runs",
            querystring: ListDiagnosesQuerySchema,
          },
        },
        async (request) => ({ items: await store.list(request.query) }),
      );

      app.get(
        "/v1/diagnoses/:id",
        {
          schema: {
            tags: ["diagnoses"],
            summary: "Get a durable diagnosis run and its report",
            params: Type.Object(
              { id: Type.String({ format: "uuid" }) },
              { additionalProperties: false },
            ),
          },
        },
        async (request) => {
          const run = await store.get(request.params.id);
          if (!run) throw new ApiError(404, "DIAGNOSIS_NOT_FOUND", "Diagnosis run not found.");
          return run;
        },
      );
    }
    return Promise.resolve();
  };
}

function persistenceFailure(error: unknown): Readonly<{
  code: DiagnosisEngineErrorCode | "INTERNAL_ERROR";
  message: string;
  cancelled: boolean;
}> {
  if (error instanceof DiagnosisEngineError) {
    const mapped = mapEngineError(error.code);
    return {
      code: error.code,
      message: mapped.message,
      cancelled: error.code === "DIAGNOSIS_ENGINE_ABORTED",
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred.",
    cancelled: false,
  };
}

interface RequestAbortSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

function createRequestAbortSignal(request: IncomingMessage): RequestAbortSignal {
  const controller = new AbortController();
  const abort = (): void => controller.abort();

  request.once("aborted", abort);
  request.socket.once("close", abort);
  if (request.aborted) abort();

  return {
    signal: controller.signal,
    dispose: () => {
      request.off("aborted", abort);
      request.socket.off("close", abort);
    },
  };
}

function validateConcurrency(value: number): void {
  validatePositiveInteger(value, "maxConcurrentDiagnoses");
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function mapEngineError(code: DiagnosisEngineErrorCode): ApiError {
  switch (code) {
    case "DIAGNOSIS_ENGINE_INVALID_INPUT":
      return new ApiError(400, code, "The diagnosis bundle is invalid.");
    case "DIAGNOSIS_ENGINE_INPUT_TOO_LARGE":
      return new ApiError(413, code, "The diagnosis bundle exceeds the allowed size.");
    case "DIAGNOSIS_ENGINE_TIMEOUT":
      return new ApiError(504, code, "The diagnosis operation timed out.");
    case "DIAGNOSIS_ENGINE_START_FAILED":
      return new ApiError(503, code, "The diagnosis engine is unavailable.");
    case "DIAGNOSIS_ENGINE_ABORTED":
      return new ApiError(499, code, "The diagnosis request was cancelled.");
    case "DIAGNOSIS_ENGINE_PROCESS_FAILED":
    case "DIAGNOSIS_ENGINE_IO_FAILED":
    case "DIAGNOSIS_ENGINE_INVALID_OUTPUT":
    case "DIAGNOSIS_ENGINE_OUTPUT_TOO_LARGE":
    case "DIAGNOSIS_ENGINE_STDERR_TOO_LARGE":
      return new ApiError(502, code, "The diagnosis engine returned an invalid response.");
    case "DIAGNOSIS_ENGINE_INVALID_CONFIGURATION":
      return new ApiError(500, code, "The diagnosis engine is misconfigured.");
  }
}

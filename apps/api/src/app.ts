import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { DiagnosisEngine } from "@prompt-regression/diagnosis-engine";

import type { CatalogService, ReadinessCheck } from "./catalog-service.js";
import type { DiagnosisStore } from "./diagnosis-store.js";
import { ApiError } from "./errors.js";
import { catalogRoutes } from "./routes/catalog.js";
import { diagnosisRoutes } from "./routes/diagnoses.js";

export interface BuildAppOptions {
  catalog: CatalogService;
  diagnosisEngine: DiagnosisEngine;
  diagnosisStore?: DiagnosisStore;
  maxConcurrentDiagnoses: number;
  readiness?: ReadinessCheck;
  webOrigin?: string;
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: (request) => request.headers["x-request-id"]?.toString() ?? crypto.randomUUID(),
  });
  app.setValidatorCompiler(TypeBoxValidatorCompiler);

  await app.register(sensible);
  await app.register(cors, {
    origin: options.webOrigin ?? "http://localhost:5173",
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "AI Chat Eval Platform API",
        description: "Versioned prompt and evaluation framework catalog API.",
        version: "0.1.0",
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.get("/health/live", () => ({ status: "ok" as const }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await options.readiness?.();
      return { status: "ready" as const };
    } catch (error) {
      app.log.error({ err: error }, "readiness check failed");
      return reply.code(503).send({ status: "not_ready" as const });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
        requestId: request.id,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }

    if (error && typeof error === "object" && "validation" in error && error.validation) {
      return reply.code(400).send({
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        requestId: request.id,
        details: error.validation,
      });
    }

    request.log.error({ err: error }, "unhandled request error");
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      requestId: request.id,
    });
  });

  await app.register(catalogRoutes(options.catalog));
  await app.register(
    diagnosisRoutes({
      engine: options.diagnosisEngine,
      maxConcurrentDiagnoses: options.maxConcurrentDiagnoses,
      ...(options.diagnosisStore ? { store: options.diagnosisStore } : {}),
    }),
  );

  return app;
}

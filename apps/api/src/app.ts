import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import type { DiagnosisEngine } from "@prompt-regression/diagnosis-engine";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";

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
  authToken?: string;
  bodyLimitBytes?: number;
  docsEnabled?: boolean;
  productionMode?: boolean;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  diagnosisRateLimitMax?: number;
  trustProxy?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const bodyLimitBytes = options.bodyLimitBytes ?? 8 * 1024 * 1024;
  const docsEnabled = options.docsEnabled ?? true;
  const productionMode = options.productionMode ?? false;
  const rateLimitMax = options.rateLimitMax ?? 120;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;
  const diagnosisRateLimitMax = options.diagnosisRateLimitMax ?? 10;

  validateBuildAppOptions({
    authToken: options.authToken,
    bodyLimitBytes,
    productionMode,
    rateLimitMax,
    rateLimitWindowMs,
    diagnosisRateLimitMax,
  });

  const app = Fastify({
    bodyLimit: bodyLimitBytes,
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
    genReqId: (request) => normalizeRequestId(request.headers["x-request-id"]),
  });
  app.setValidatorCompiler(TypeBoxValidatorCompiler);

  await app.register(helmet, {
    ...(docsEnabled ? { contentSecurityPolicy: false } : {}),
    ...(productionMode ? {} : { strictTransportSecurity: false }),
  });
  await app.register(rateLimit, {
    global: true,
    max: rateLimitMax,
    timeWindow: rateLimitWindowMs,
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests. Try again later.",
      requestId: request.id,
      retryAfter: context.after,
    }),
  });
  await app.register(sensible);
  await app.register(cors, {
    origin: options.webOrigin ?? "http://localhost:5173",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-request-id"],
    exposedHeaders: ["location", "x-diagnosis-run-id", "x-request-id"],
  });

  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
    if (
      options.authToken === undefined ||
      request.method === "OPTIONS" ||
      !isProtectedPath(request)
    ) {
      return;
    }

    const presentedToken = readBearerToken(request.headers.authorization);
    if (presentedToken === undefined || !tokensMatch(presentedToken, options.authToken)) {
      return reply
        .header("www-authenticate", 'Bearer realm="prompt-regression-studio"')
        .code(401)
        .send({
          code: "UNAUTHORIZED",
          message: "A valid API bearer token is required.",
          requestId: request.id,
        });
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (isProtectedPath(request)) {
      void reply.header("cache-control", "no-store");
      void reply.header("pragma", "no-cache");
    }
    return payload;
  });

  if (docsEnabled) {
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
  }

  app.get("/health/live", { config: { rateLimit: false } }, () => ({ status: "ok" as const }));
  app.get("/health/ready", { config: { rateLimit: false } }, async (_request, reply) => {
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

    if (hasStatusCode(error, 429)) {
      return reply.code(429).send({
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Try again later.",
        requestId: request.id,
      });
    }

    if (hasStatusCode(error, 413)) {
      return reply.code(413).send({
        code: "PAYLOAD_TOO_LARGE",
        message: "The request body exceeds the allowed size.",
        requestId: request.id,
      });
    }

    request.log.error({ err: error }, "unhandled request error");
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      requestId: request.id,
    });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
      requestId: request.id,
    }),
  );

  await app.register(catalogRoutes(options.catalog));
  await app.register(
    diagnosisRoutes({
      engine: options.diagnosisEngine,
      maxConcurrentDiagnoses: options.maxConcurrentDiagnoses,
      rateLimitMax: diagnosisRateLimitMax,
      rateLimitWindowMs,
      ...(options.diagnosisStore ? { store: options.diagnosisStore } : {}),
    }),
  );

  return app;
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function normalizeRequestId(value: string | string[] | undefined): string {
  return typeof value === "string" && requestIdPattern.test(value) ? value : randomUUID();
}

function isProtectedPath(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0];
  return path === "/v1" || path?.startsWith("/v1/") === true;
}

function readBearerToken(authorization: string | undefined): string | undefined {
  return authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
}

function tokensMatch(presented: string, expected: string): boolean {
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

interface ResolvedSecurityOptions {
  readonly authToken: string | undefined;
  readonly bodyLimitBytes: number;
  readonly productionMode: boolean;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly diagnosisRateLimitMax: number;
}

function validateBuildAppOptions(options: ResolvedSecurityOptions): void {
  if (
    options.authToken !== undefined &&
    (options.authToken.length < 32 ||
      options.authToken.length > 512 ||
      !isSafeAuthToken(options.authToken))
  ) {
    throw new RangeError(
      "authToken must contain 32-512 characters without whitespace or control characters.",
    );
  }
  if (options.productionMode && options.authToken === undefined) {
    throw new Error("authToken is required in production mode.");
  }

  for (const [name, value] of [
    ["bodyLimitBytes", options.bodyLimitBytes],
    ["rateLimitMax", options.rateLimitMax],
    ["rateLimitWindowMs", options.rateLimitWindowMs],
    ["diagnosisRateLimitMax", options.diagnosisRateLimitMax],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }

  if (options.diagnosisRateLimitMax > options.rateLimitMax) {
    throw new RangeError("diagnosisRateLimitMax cannot exceed rateLimitMax.");
  }
}

function isSafeAuthToken(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "," || character.trim() === "" || codePoint < 32 || codePoint === 127) {
      return false;
    }
  }
  return true;
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === statusCode
  );
}

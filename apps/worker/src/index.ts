import {
  createRedisConnection,
  EVALUATION_QUEUE_NAME,
  type EvaluationJob,
} from "@ai-chat-eval/queue";
import { Worker } from "bullmq";
import type { Server } from "node:http";

import { readWorkerConfig } from "./config.js";
import { closeHealthServer, startHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import { processEvaluationJob, type EvaluationJobName } from "./processor.js";

async function main(): Promise<void> {
  const config = readWorkerConfig();
  const logger = createLogger(config.logLevel);
  const redis = createRedisConnection(config.redisUrl);
  let ready = false;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let healthServer: Server | undefined;

  redis.on("error", (error: Error) => {
    logger.error("Redis connection error", { error });
  });

  const worker = new Worker<EvaluationJob, never, EvaluationJobName>(
    EVALUATION_QUEUE_NAME,
    (job) => processEvaluationJob(job, logger),
    {
      connection: redis,
      concurrency: config.concurrency,
    },
  );

  worker.on("active", (job) => {
    logger.debug("Job started", { queueJobId: job.id, jobName: job.name });
  });
  worker.on("failed", (job, error) => {
    logger.error("Job failed", {
      queueJobId: job?.id,
      jobName: job?.name,
      attemptsMade: job?.attemptsMade,
      error,
    });
  });
  worker.on("error", (error) => {
    logger.error("Worker error", { error });
  });

  const shutdown = (reason: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      shuttingDown = true;
      ready = false;
      logger.info("Worker shutdown started", { reason });

      const forceShutdown = new Promise<"timeout">((resolve) => {
        const timeout = setTimeout(() => resolve("timeout"), config.shutdownTimeoutMs);
        timeout.unref();
      });
      const gracefulShutdown = (async (): Promise<"closed"> => {
        await worker.close(false).catch((error: unknown) => {
          logger.error("Graceful worker close failed", { error });
        });
        await redis.quit().catch((error: unknown) => {
          logger.error("Graceful Redis close failed", { error });
        });
        if (healthServer) {
          await closeHealthServer(healthServer).catch((error: unknown) => {
            logger.error("Graceful health server close failed", { error });
          });
        }
        return "closed";
      })();

      const result = await Promise.race([gracefulShutdown, forceShutdown]);
      if (result === "timeout") {
        logger.warn("Graceful shutdown timed out; forcing worker close", {
          timeoutMs: config.shutdownTimeoutMs,
        });
        await worker.close(true).catch((error: unknown) => {
          logger.error("Forced worker close failed", { error });
        });
        redis.disconnect(false);
        if (healthServer) {
          healthServer.closeAllConnections();
          await closeHealthServer(healthServer).catch((error: unknown) => {
            logger.error("Health server close failed", { error });
          });
        }
      }

      logger.info("Worker shutdown complete", { reason });
    })();

    return shutdownPromise;
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  try {
    healthServer = await startHealthServer({
      host: config.healthHost,
      port: config.healthPort,
      redis,
      state: {
        isReady: () => ready,
        isShuttingDown: () => shuttingDown,
      },
      logger,
    });
    await worker.waitUntilReady();
    ready = true;
    logger.info("Worker ready", {
      queue: EVALUATION_QUEUE_NAME,
      concurrency: config.concurrency,
      healthAddress: `http://${config.healthHost}:${config.healthPort}`,
    });
  } catch (error) {
    logger.error("Worker failed to start", { error });
    await shutdown("startup_failure").catch((shutdownError: unknown) => {
      logger.error("Worker startup cleanup failed", { error: shutdownError });
    });
    throw error;
  }
}

void main().catch((error: unknown) => {
  const logger = createLogger("error");
  logger.error("Worker terminated unexpectedly", { error });
  process.exitCode = 1;
});

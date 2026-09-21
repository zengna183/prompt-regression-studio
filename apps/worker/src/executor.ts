import type { EvaluationRepository, JsonValue, SaveGenerationOutputInput } from "@ai-chat-eval/db";
import {
  OpenAICompatibleClient,
  ProviderError,
  type ChatMessage,
} from "@prompt-regression/model-provider";
import { createHash } from "node:crypto";

import { evaluateGeneratedOutput } from "./evaluator.js";
import type { Logger } from "./logger.js";

export interface EvaluationExecutorOptions {
  readonly repository: EvaluationRepository;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly production: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export interface EvaluationExecutionResult {
  readonly status: "completed" | "already_claimed";
  readonly succeededCount: number;
  readonly failedCount: number;
}

export interface EvaluationExecutor {
  execute(
    evaluationRunId: string,
    logger: Logger,
    generationRunId?: string,
  ): Promise<EvaluationExecutionResult>;
}

export function createEvaluationExecutor(options: EvaluationExecutorOptions): EvaluationExecutor {
  const client = new OpenAICompatibleClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    production: options.production,
    allowPrivateNetwork: options.allowPrivateNetwork,
    timeoutMs: options.timeoutMs,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  return {
    async execute(evaluationRunId, logger, generationRunId) {
      const snapshot = await options.repository.getExecutionSnapshot(evaluationRunId);
      if (!snapshot) throw new Error(`Evaluation run not found: ${evaluationRunId}`);
      if (generationRunId !== undefined && snapshot.generationRun.id !== generationRunId) {
        throw new Error("Evaluation job generation run does not match its evaluation run");
      }

      const claimed = await options.repository.claimEvaluation(evaluationRunId);
      if (!claimed) {
        return { status: "already_claimed", succeededCount: 0, failedCount: 0 };
      }
      await options.repository.startGenerationRun(snapshot.generationRun.id);

      try {
        let succeededCount = 0;
        let failedCount = 0;
        for (const evaluationCase of snapshot.cases) {
          const startedAt = Date.now();
          const messages: ChatMessage[] = [
            { role: "system", content: snapshot.promptVersion.compiledContent },
            { role: "user", content: stringifyCaseInput(evaluationCase.input) },
          ];
          const requestForPersistence: JsonValue = {
            model: snapshot.generationRun.model,
            messages: messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          };

          let response;
          try {
            response = await client.complete({
              model: snapshot.generationRun.model,
              messages,
            });
            const output: SaveGenerationOutputInput = {
              generationRunId: snapshot.generationRun.id,
              caseId: evaluationCase.id,
              request: requestForPersistence,
              outputText: response.text,
              rawResponse: {
                provider: response.provider,
                model: response.model,
                usage: {
                  inputTokens: response.usage.inputTokens,
                  outputTokens: response.usage.outputTokens,
                  totalTokens: response.usage.totalTokens,
                },
              },
              outputHash: sha256(response.text),
              latencyMs: boundedLatency(Date.now() - startedAt),
              inputTokens: response.usage.inputTokens ?? undefined,
              outputTokens: response.usage.outputTokens ?? undefined,
              providerRequestId: response.providerRequestId ?? undefined,
              status: "succeeded",
              attemptCount: 1,
            };
            const savedOutput = await options.repository.saveGenerationOutput(output);
            const evaluatorModel = readEvaluatorModel(
              snapshot.evaluationRun.evaluatorConfig,
              snapshot.generationRun.model,
            );
            const scored = await evaluateGeneratedOutput({
              client,
              evaluationRunId,
              generationOutputId: savedOutput.id,
              evaluatorModel,
              framework: snapshot.frameworkVersion.definition,
              expectedOutput: evaluationCase.expectedOutput,
              outputText: response.text,
            });
            await options.repository.saveScores(scored.scores);
            succeededCount += 1;
          } catch (error) {
            const failure = normalizeFailure(error);
            await options.repository.saveGenerationOutput({
              generationRunId: snapshot.generationRun.id,
              caseId: evaluationCase.id,
              request: requestForPersistence,
              latencyMs: boundedLatency(Date.now() - startedAt),
              errorCode: failure.code,
              errorMessage: failure.message,
              status: "failed",
              attemptCount: 1,
            });
            failedCount += 1;
            logger.warn("Evaluation case failed", {
              evaluationRunId,
              caseId: evaluationCase.id,
              errorCode: failure.code,
            });
          }
        }

        await options.repository.completeGenerationRun(snapshot.generationRun.id, {
          succeededCount,
          failedCount,
        });
        await options.repository.completeEvaluationRun(evaluationRunId, {
          succeededCount,
          failedCount,
        });
        return { status: "completed", succeededCount, failedCount };
      } catch (error) {
        await Promise.allSettled([
          options.repository.failGenerationRun(snapshot.generationRun.id, {
            code: "EVALUATION_EXECUTION_FAILED",
            message: "The evaluation worker could not finish this run.",
          }),
          options.repository.failEvaluationRun(evaluationRunId, {
            code: "EVALUATION_EXECUTION_FAILED",
            message: "The evaluation worker could not finish this run.",
          }),
        ]);
        throw error;
      }
    },
  };
}

function readEvaluatorModel(value: Record<string, JsonValue>, fallback: string): string {
  const candidate = value.model;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : fallback;
}

export function stringifyCaseInput(input: unknown): string {
  if (typeof input === "string") return input;
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new Error("Evaluation case input is not JSON serializable");
  if (serialized.length > 1_000_000) throw new Error("Evaluation case input is too large");
  return serialized;
}

function normalizeFailure(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof ProviderError) {
    return { code: error.code, message: error.message };
  }
  return { code: "EVALUATION_CASE_FAILED", message: "The evaluation case could not be completed." };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedLatency(value: number): number {
  return Math.max(0, Math.min(value, 2_147_483_647));
}

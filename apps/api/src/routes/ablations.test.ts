import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import { describe, expect, it, vi } from "vitest";

import { ablationRoutes } from "./ablations.js";
import type { AblationService } from "../ablation-service.js";

const project = "00000000-0000-4000-8000-000000000001";
const source = "00000000-0000-4000-8000-000000000002";
const candidate = "00000000-0000-4000-8000-000000000003";
const experiment = "00000000-0000-4000-8000-000000000004";
const link = {
  id: "00000000-0000-4000-8000-000000000005",
  sourceExperimentId: source,
  candidatePromptVersionId: candidate,
  revertedBlockId: "policy",
  experimentId: experiment,
  variantPromptVersionId: "00000000-0000-4000-8000-000000000006",
  createdAt: "2026-10-09T00:00:00.000Z",
};
const path = `/v1/projects/${project}/experiments/${source}/ablations`;
const createLink = vi.fn(() => Promise.resolve(link));
const service: AblationService = {
  create: createLink,
  list: vi.fn(() => Promise.resolve([link])),
};
async function appFor(value?: AblationService) {
  const app = Fastify();
  app.setValidatorCompiler(TypeBoxValidatorCompiler);
  await app.register(rateLimit, { global: false });
  await app.register(ablationRoutes(value));
  return app;
}

describe("ablation routes", () => {
  it("queues by source selection and exposes the normal experiment status URL", async () => {
    const app = await appFor(service);
    try {
      const response = await app.inject({
        method: "POST",
        url: path,
        payload: { candidatePromptVersionId: candidate, blockId: "policy" },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(link);
      expect(response.headers.location).toBe(`/v1/projects/${project}/experiments/${experiment}`);
      expect(createLink).toHaveBeenCalledWith(project, source, {
        candidatePromptVersionId: candidate,
        blockId: "policy",
      });
      const list = await app.inject({ method: "GET", url: path });
      expect(list.json()).toEqual([link]);
    } finally {
      await app.close();
    }
  });
  it.each([
    { candidatePromptVersionId: candidate, blockId: "policy", model: "cheaper-model" },
    { candidatePromptVersionId: candidate, blockId: "policy", repetition: 2 },
    { candidatePromptVersionId: candidate, blockId: "../policy" },
    { candidatePromptVersionId: "not-a-uuid", blockId: "policy" },
    { candidatePromptVersionId: candidate, blockId: "" },
  ])("refuses invalid selections and caller-controlled replay settings", async (payload) => {
    const create = vi.fn(() => Promise.resolve(link));
    const app = await appFor({ ...service, create });
    try {
      const response = await app.inject({ method: "POST", url: path, payload });
      expect(response.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("rate-limits paid job creation before invoking the service", async () => {
    const create = vi.fn(() => Promise.resolve(link));
    const app = await appFor({ ...service, create });
    try {
      for (let i = 0; i < 5; i += 1) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: path,
              payload: { candidatePromptVersionId: candidate, blockId: "policy" },
            })
          ).statusCode,
        ).toBe(202);
      }
      expect(
        (
          await app.inject({
            method: "POST",
            url: path,
            payload: { candidatePromptVersionId: candidate, blockId: "policy" },
          })
        ).statusCode,
      ).toBe(429);
      expect(create).toHaveBeenCalledTimes(5);
    } finally {
      await app.close();
    }
  });
});

import type { Database } from "@ai-chat-eval/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordedFixture } from "./fixtures/recorded-ablation.js";
import { createDatabaseExperimentDiagnosisSource } from "./database-experiment-diagnosis-source.js";

const mocks = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn() }));
vi.mock("@ai-chat-eval/db", async (load) => ({
  ...(await load<Record<string, unknown>>()),
  createExperimentDiagnosisRepository: () => ({ get: mocks.get }),
  createAblationRepository: () => ({ list: mocks.list }),
}));

describe("saved experiment evidence source", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  function setup() {
    const fixture = recordedFixture();
    mocks.get.mockImplementation((_project: string, id: string) =>
      Promise.resolve(id === fixture.source.experiment.id ? fixture.source : fixture.record),
    );
    mocks.list.mockResolvedValue([fixture.link]);
    return { ...fixture, service: createDatabaseExperimentDiagnosisSource({} as Database) };
  }
  it("loads evidence only on explicit request and scopes every read to the project", async () => {
    const fixture = setup();
    const projectId = fixture.source.project.id,
      experimentId = fixture.source.experiment.id;
    const plain = await fixture.service.build(projectId, experimentId, {
      candidatePromptVersionId: fixture.input.candidatePromptVersionId,
    });
    expect(plain.recorded_ablation_runs_by_segment).toBeUndefined();
    expect(mocks.list).not.toHaveBeenCalled();
    const recorded = await fixture.service.build(projectId, experimentId, fixture.input);
    expect(recorded.recorded_ablation_runs_by_segment).toHaveProperty("policy");
    expect(mocks.list).toHaveBeenCalledWith(projectId, experimentId);
    expect(mocks.get).toHaveBeenCalledWith(projectId, fixture.link.experimentId, 1);
  });
  it("does not accept another candidate's evidence or silently skip missing snapshots", async () => {
    const fixture = setup();
    mocks.list.mockResolvedValue([{ ...fixture.link, candidatePromptVersionId: "another" }]);
    await expect(
      fixture.service.build(fixture.source.project.id, fixture.source.experiment.id, fixture.input),
    ).rejects.toMatchObject({ statusCode: 409, code: "ABLATION_RESULTS_UNAVAILABLE" });
    mocks.list.mockResolvedValue([fixture.link]);
    mocks.get.mockResolvedValueOnce(fixture.source).mockResolvedValueOnce(null);
    await expect(
      fixture.service.build(fixture.source.project.id, fixture.source.experiment.id, fixture.input),
    ).rejects.toMatchObject({ statusCode: 409, code: "ABLATION_RESULTS_UNAVAILABLE" });
  });
  it("refuses unfinished evidence and a repetition whose seed has no recorded replay", async () => {
    const fixture = setup();
    fixture.record.runs.forEach((run) => {
      run.evaluationRun.status = "running";
    });
    await expect(
      fixture.service.build(fixture.source.project.id, fixture.source.experiment.id, fixture.input),
    ).rejects.toMatchObject({ statusCode: 409, code: "DIAGNOSIS_INPUT_INCOMPLETE" });
    await expect(
      fixture.service.build(fixture.source.project.id, fixture.source.experiment.id, {
        ...fixture.input,
        repetition: 2,
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "ABLATION_REPETITION_UNSUPPORTED" });
  });
});

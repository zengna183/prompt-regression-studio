import { describe, expect, it } from "vitest";

import { recordedFixture } from "./fixtures/recorded-ablation.js";
import { ExperimentDiagnosisBuildError } from "./experiment-diagnosis.js";
import { buildRecordedAblationBundle } from "./recorded-ablation.js";

describe("recorded intervention bundle", () => {
  it("preserves saved evaluation IDs and the fresh replay without creating fixture evidence", () => {
    const { source, input, link, record } = recordedFixture();
    const first = buildRecordedAblationBundle(source, input, [{ link, record }]);
    expect(first).toEqual(buildRecordedAblationBundle(source, input, [{ link, record }]));
    expect(first.mock_ablation_results_by_segment).toEqual({});
    expect(first.recorded_ablation_runs_by_segment).toMatchObject({
      policy: {
        id: link.id,
        experiment_id: link.experimentId,
        eval_run: {
          id: record.runs[1]?.evaluationRun.id,
          prompt_version_id: link.variantPromptVersionId,
        },
        candidate_replay_eval_run: {
          id: record.runs[0]?.evaluationRun.id,
          prompt_version_id: input.candidatePromptVersionId,
        },
      },
    });
  });
  it("rejects a different source, project, candidate, dataset, model or saved variant", () => {
    const mutations = [
      (fixture: ReturnType<typeof recordedFixture>) => {
        fixture.link.sourceExperimentId = "wrong";
      },
      (fixture: ReturnType<typeof recordedFixture>) => {
        fixture.record.project.id = "wrong";
      },
      (fixture: ReturnType<typeof recordedFixture>) => {
        fixture.link.candidatePromptVersionId = "wrong";
      },
      (fixture: ReturnType<typeof recordedFixture>) => {
        fixture.record.datasetVersion.id = "wrong";
      },
      (fixture: ReturnType<typeof recordedFixture>) => {
        fixture.record.runs.forEach((run) => {
          run.generationRun.model = "wrong";
        });
      },
      (fixture: ReturnType<typeof recordedFixture>) => {
        const selection = fixture.record.promptVersions[1];
        if (selection) selection.version.blocks[0]!.content = "wrong";
      },
    ];
    for (const mutate of mutations) {
      const fixture = recordedFixture();
      mutate(fixture);
      expect(() => buildRecordedAblationBundle(fixture.source, fixture.input, [fixture])).toThrow();
    }
  });
  it("refuses missing outputs, scores, unfinished runs and reused evaluation IDs", () => {
    const mutations = [
      (fixture: ReturnType<typeof recordedFixture>) => {
        fixture.record.outputs.pop();
      },
      (fixture: ReturnType<typeof recordedFixture>) => {
        fixture.record.scores.pop();
      },
      (fixture: ReturnType<typeof recordedFixture>) => {
        fixture.record.runs.forEach((run) => {
          run.evaluationRun.status = "running";
        });
      },
      (fixture: ReturnType<typeof recordedFixture>) => {
        const run = fixture.record.runs[0];
        if (run) {
          const oldId = run.evaluationRun.id;
          run.evaluationRun.id = fixture.source.runs[0]!.evaluationRun.id;
          fixture.record.scores.forEach((score) => {
            if (score.evaluationRunId === oldId) score.evaluationRunId = run.evaluationRun.id;
          });
        }
      },
    ];
    for (const mutate of mutations) {
      const fixture = recordedFixture();
      mutate(fixture);
      expect(() => buildRecordedAblationBundle(fixture.source, fixture.input, [fixture])).toThrow();
    }
  });
  it("rejects empty evidence, duplicate interventions and unsupported repetitions", () => {
    const fixture = recordedFixture();
    expect(() => buildRecordedAblationBundle(fixture.source, fixture.input, [])).toThrow();
    expect(() =>
      buildRecordedAblationBundle(fixture.source, fixture.input, [fixture, fixture]),
    ).toThrow();
    expect(() =>
      buildRecordedAblationBundle(fixture.source, { ...fixture.input, repetition: 2 }, [fixture]),
    ).toThrow("repetition 1");
  });
  it("returns a domain error rather than an internal error for an invalid saved revert", () => {
    const fixture = recordedFixture();
    fixture.link.revertedBlockId = "unknown-block";
    expect(() => buildRecordedAblationBundle(fixture.source, fixture.input, [fixture])).toThrow(
      ExperimentDiagnosisBuildError,
    );
  });
});

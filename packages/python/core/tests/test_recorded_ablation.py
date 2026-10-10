from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import unittest

from prompt_regression_core import (
    BundleValidationError,
    DiagnosisPipeline,
    HypothesisStatus,
    MarkdownReporter,
    canonical_json,
    parse_bundle,
)


EXAMPLE = Path(__file__).resolve().parents[4] / "examples" / "missing-information-regression" / "regression-bundle.json"


def recorded_bundle() -> dict:
    raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    segment_id = next(iter(raw["mock_ablation_results_by_segment"]))
    results = raw["mock_ablation_results_by_segment"][segment_id]
    prompt = deepcopy(raw["baseline_prompt_version"])
    prompt.update(id="saved-reverted-prompt", version=3)
    prompt.pop("content_hash", None)
    replay = deepcopy(raw["candidate_eval_run"])
    replay["id"] = "saved-candidate-replay"
    evaluation = deepcopy(raw["candidate_eval_run"])
    evaluation.update(id="saved-reverted-evaluation", prompt_version_id=prompt["id"], results=results)
    raw["mock_ablation_results_by_segment"] = {}
    raw["recorded_ablation_runs_by_segment"] = {segment_id: {
        "id": "saved-ablation-link", "source_experiment_id": "source-experiment",
        "experiment_id": "revert-experiment", "prompt_version": prompt,
        "eval_run": evaluation, "candidate_replay_eval_run": replay,
    }}
    return raw


class RecordedAblationTest(unittest.TestCase):
    def record(self, raw: dict) -> dict:
        return next(iter(raw["recorded_ablation_runs_by_segment"].values()))

    def test_real_ids_and_replay_are_preserved_and_report_is_deterministic(self) -> None:
        raw = recorded_bundle()
        first = DiagnosisPipeline().run(parse_bundle(raw))
        second = DiagnosisPipeline().run(parse_bundle(raw))
        self.assertEqual(canonical_json(first), canonical_json(second))
        self.assertEqual(first.hypotheses[0].verification_status, HypothesisStatus.SUPPORTED)
        run = first.ablation_runs[0]
        self.assertEqual(run.runner, "recorded-evaluation-runner")
        self.assertEqual(run.eval_run.id, "saved-reverted-evaluation")
        self.assertEqual(run.eval_run.prompt_version_id, "saved-reverted-prompt")
        self.assertEqual(run.provenance["experiment_id"], "revert-experiment")
        self.assertIn("one paired repetition", " ".join(first.recommendations))

    def test_markdown_preserves_saved_evidence_trace(self) -> None:
        report = DiagnosisPipeline().run(parse_bundle(recorded_bundle()))
        rendered = MarkdownReporter().render(report)
        self.assertIn("recorded-evaluation-runner", rendered)
        self.assertIn("saved-reverted-evaluation", rendered)
        self.assertIn("revert-experiment", rendered)
        self.assertIn(report.input_bundle_hash, rendered)
        self.assertNotIn("explicit-fixture-runner", rendered)

    def test_candidate_replay_drift_is_inconclusive_even_when_variant_improves(self) -> None:
        raw = recorded_bundle()
        replay = self.record(raw)["candidate_replay_eval_run"]
        replay["results"][0]["metrics"][0]["score"] += 0.2
        report = DiagnosisPipeline().run(parse_bundle(raw))
        self.assertEqual(report.hypotheses[0].verification_status, HypothesisStatus.INCONCLUSIVE)
        self.assertIn("replay was unstable", report.evidence[0].rationale)

    def test_replay_pass_changes_cannot_be_hidden_by_loosening_drift_threshold(self) -> None:
        raw = recorded_bundle()
        raw["detection"]["max_replay_drift"] = 1
        self.record(raw)["candidate_replay_eval_run"]["results"][0]["passed"] = True
        report = DiagnosisPipeline().run(parse_bundle(raw))
        self.assertEqual(report.hypotheses[0].verification_status, HypothesisStatus.INCONCLUSIVE)

    def test_no_recovery_rejects_and_small_samples_remain_inconclusive(self) -> None:
        raw = recorded_bundle()
        self.record(raw)["eval_run"]["results"] = deepcopy(raw["candidate_eval_run"]["results"])
        report = DiagnosisPipeline().run(parse_bundle(raw))
        self.assertEqual(report.hypotheses[0].verification_status, HypothesisStatus.REJECTED)
        raw["detection"]["min_target_cases"] = 99
        report = DiagnosisPipeline().run(parse_bundle(raw))
        self.assertEqual(report.hypotheses[0].verification_status, HypothesisStatus.INCONCLUSIVE)

    def test_control_damage_on_a_non_primary_dimension_is_not_hidden(self) -> None:
        raw = recorded_bundle()
        record = self.record(raw)
        for run in [raw["baseline_eval_run"], raw["candidate_eval_run"], record["candidate_replay_eval_run"], record["eval_run"]]:
            for result in run["results"]:
                result["metrics"].append({"metric_key": "extra-safety", "score": 1, "passed": True})
        # A non-regression case; primary score and overall pass still look healthy.
        controls = {item["test_case_id"] for item in raw["candidate_eval_run"]["results"] if item["passed"]}
        control = next(item for item in record["eval_run"]["results"] if item["test_case_id"] in controls)
        control["metrics"][-1]["score"] = 0.5
        report = DiagnosisPipeline().run(parse_bundle(raw))
        self.assertEqual(report.hypotheses[0].verification_status, HypothesisStatus.INCONCLUSIVE)
        self.assertEqual(report.evidence[0].max_observed_control_damage, 0.5)

    def test_rejects_missing_results_tampered_variants_mixed_fixtures_and_changed_snapshots(self) -> None:
        mutations = [
            lambda raw: self.record(raw)["eval_run"]["results"].pop(),
            lambda raw: self.record(raw)["prompt_version"]["segments"][0].update(content="unrelated rewrite"),
            lambda raw: raw.update(mock_ablation_results_by_segment={next(iter(raw["recorded_ablation_runs_by_segment"])): raw["candidate_eval_run"]["results"]}),
            lambda raw: self.record(raw)["candidate_replay_eval_run"]["model_snapshot"].update(model="changed"),
            lambda raw: self.record(raw)["eval_run"].update(id=raw["candidate_eval_run"]["id"]),
            lambda raw: self.record(raw)["eval_run"]["results"][0]["metrics"].append({"metric_key": "unexpected", "score": 1}),
            lambda raw: raw["detection"].update(max_replay_drift=-1),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                raw = recorded_bundle()
                mutate(raw)
                with self.assertRaises(BundleValidationError):
                    parse_bundle(raw)

    def test_recovery_in_one_cluster_cannot_hide_damage_in_another_cluster(self) -> None:
        raw = recorded_bundle()
        candidate = raw["candidate_eval_run"]["results"]
        candidate[1].setdefault("metadata", {})["failure_mode"] = "another-cluster"
        self.record(raw)["candidate_replay_eval_run"]["results"] = deepcopy(candidate)
        case_id = candidate[1]["test_case_id"]
        result = next(item for item in self.record(raw)["eval_run"]["results"] if item["test_case_id"] == case_id)
        result["metrics"][0]["score"] = 0
        result["passed"] = False
        report = DiagnosisPipeline().run(parse_bundle(raw))
        self.assertEqual(len(report.failure_clusters), 2)
        self.assertFalse(any(item.verification_status is HypothesisStatus.SUPPORTED for item in report.hypotheses))
        self.assertTrue(any(case_id in item.off_target_harmed_case_ids for item in report.evidence))

    def test_added_and_removed_blocks_use_the_saved_normalized_order(self) -> None:
        def segment(name: str, ordinal: int) -> dict:
            return {"id": name, "kind": "policy", "content": name, "ordinal": ordinal, "semantic_tags": []}
        for mode in ("added", "removed"):
            with self.subTest(mode=mode):
                raw = recorded_bundle()
                record = self.record(raw)
                if mode == "added":
                    before = [segment("a", 0), segment("b", 1)]
                    after = [segment("a", 0), segment("x", 1), segment("b", 2)]
                    block_id = "x"
                else:
                    before = [segment("a", 0), segment("b", 1), segment("c", 2)]
                    after = [segment("a", 0), segment("c", 1)]
                    block_id = "b"
                for prompt, segments in [(raw["baseline_prompt_version"], before), (raw["candidate_prompt_version"], after), (record["prompt_version"], before)]:
                    prompt["segments"] = segments
                    prompt.pop("content_hash", None)
                raw["recorded_ablation_runs_by_segment"] = {block_id: record}
                report = DiagnosisPipeline().run(parse_bundle(raw))
                self.assertTrue(any(item.runner == "recorded-evaluation-runner" for item in report.ablation_runs))


if __name__ == "__main__":
    unittest.main()

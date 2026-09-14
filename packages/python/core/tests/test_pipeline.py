from __future__ import annotations

from contextlib import redirect_stdout
from dataclasses import replace
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from prompt_regression_core import (
    BundleValidationError,
    DiagnosisPipeline,
    EvidenceStance,
    HypothesisStatus,
    MarkdownReporter,
    PipelineInvariantError,
    canonical_json,
    load_bundle,
    parse_bundle,
)
from prompt_regression_core.cli import main
from prompt_regression_core.strategies import (
    FixtureAblationRunner,
    MetadataFailureClusterer,
    RuleBasedRootCauseStrategy,
    SingleSegmentRevertStrategy,
    StableSegmentDiff,
    ThresholdEvidenceScorer,
)
from prompt_regression_core.model import PromptChangeType
from prompt_regression_core.ports import (
    AblationRunner,
    AblationStrategy,
    EvidenceScorer,
    FailureClusterer,
    RootCauseStrategy,
    SemanticDiffStrategy,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
EXAMPLE = (
    REPOSITORY_ROOT
    / "examples"
    / "missing-information-regression"
    / "regression-bundle.json"
)


class DiagnosisPipelineTest(unittest.TestCase):
    def test_complete_vertical_slice_links_controlled_evidence(self) -> None:
        bundle = load_bundle(EXAMPLE)
        report = DiagnosisPipeline().run(bundle)

        self.assertEqual(len(report.regression.cases), 2)
        self.assertEqual(len(report.prompt_changes), 1)
        self.assertEqual(len(report.failure_clusters), 1)
        self.assertEqual(len(report.hypotheses), 1)
        self.assertEqual(len(report.ablation_plans), 1)
        self.assertEqual(len(report.ablation_variants), 1)
        self.assertEqual(len(report.ablation_runs), 1)
        self.assertEqual(len(report.evidence), 1)

        hypothesis = report.hypotheses[0]
        evidence = report.evidence[0]
        plan = report.ablation_plans[0]
        change = report.prompt_changes[0]
        self.assertEqual(hypothesis.verification_status, HypothesisStatus.SUPPORTED)
        self.assertEqual(hypothesis.prompt_change_ids, (change.id,))
        self.assertEqual(evidence.hypothesis_id, hypothesis.id)
        self.assertEqual(evidence.cluster_id, report.failure_clusters[0].id)
        self.assertEqual(evidence.target_sample_size, 2)
        self.assertEqual(evidence.control_sample_size, 2)
        self.assertGreater(evidence.recovery_ratio or 0.0, 0.9)
        self.assertEqual(evidence.control_mean_delta, 0.0)
        self.assertEqual(evidence.max_observed_control_damage, 0.0)
        self.assertEqual(evidence.unrecovered_hard_targets, 0)
        self.assertEqual(evidence.new_control_failures, 0)
        self.assertEqual(set(evidence.target_case_ids), set(plan.target_test_case_ids))
        self.assertIn("hypothesis, not a causal conclusion", hypothesis.mechanism)

        ablation_run = report.ablation_runs[0]
        self.assertEqual(
            ablation_run.eval_run.model_snapshot,
            bundle.candidate_eval_run.model_snapshot,
        )
        self.assertEqual(
            ablation_run.eval_run.evaluator_snapshot,
            bundle.candidate_eval_run.evaluator_snapshot,
        )
        self.assertEqual(ablation_run.runner, "explicit-fixture-runner")

    def test_report_is_byte_deterministic(self) -> None:
        bundle = load_bundle(EXAMPLE)
        first = DiagnosisPipeline().run(bundle)
        second = DiagnosisPipeline().run(bundle)
        self.assertEqual(first.report_id, second.report_id)
        self.assertEqual(canonical_json(first), canonical_json(second))

    def test_markdown_report_separates_hypothesis_from_supported_cause(self) -> None:
        report = DiagnosisPipeline().run(load_bundle(EXAMPLE))

        rendered = MarkdownReporter().render(report)

        self.assertIn("A hypothesis is not a root cause", rendered)
        self.assertIn("SUPPORTED by controlled evidence", rendered)
        self.assertIn("Worst control damage", rendered)
        self.assertIn("target=2, control=2", rendered)
        self.assertTrue(rendered.endswith("\n"))

    def test_markdown_report_treats_strategy_text_as_untrusted(self) -> None:
        report = DiagnosisPipeline().run(load_bundle(EXAMPLE))
        hypothesis = replace(
            report.hypotheses[0],
            mechanism='<script>alert(1)</script> [click](javascript:alert(1))',
        )
        report = replace(
            report,
            hypotheses=(hypothesis,),
            recommendations=("line one\n- injected item",),
        )

        rendered = MarkdownReporter().render(report)

        self.assertNotIn("<script>", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertIn(r"\[click\]", rendered)
        self.assertNotIn("\n- - injected item", rendered)

    def test_missing_fixture_never_fabricates_ablation_evidence(self) -> None:
        raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        raw["mock_ablation_results_by_segment"] = {}
        report = DiagnosisPipeline().run(parse_bundle(raw))

        self.assertEqual(len(report.regression.cases), 2)
        self.assertEqual(len(report.ablation_plans), 1)
        self.assertEqual(len(report.ablation_variants), 1)
        self.assertEqual(report.ablation_runs, ())
        self.assertEqual(report.evidence, ())
        self.assertEqual(
            report.hypotheses[0].verification_status,
            HypothesisStatus.HYPOTHESIZED,
        )
        self.assertTrue(
            any("no explicit ablation results" in item for item in report.recommendations)
        )

    def test_failed_ablation_rejects_hypothesis(self) -> None:
        raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        fixtures = raw["mock_ablation_results_by_segment"]
        assert isinstance(fixtures, dict)
        results = fixtures["missing_information_policy"]
        assert isinstance(results, list)
        candidate_run = raw["candidate_eval_run"]
        assert isinstance(candidate_run, dict)
        candidate_results = candidate_run["results"]
        assert isinstance(candidate_results, list)
        candidate_by_case = {
            item["test_case_id"]: item for item in candidate_results if isinstance(item, dict)
        }
        for item in results:
            assert isinstance(item, dict)
            if item["test_case_id"] in {"case_missing_city", "case_missing_order"}:
                candidate = candidate_by_case[item["test_case_id"]]
                item["passed"] = False
                item["metrics"] = candidate["metrics"]
        report = DiagnosisPipeline().run(parse_bundle(raw))

        self.assertEqual(
            report.hypotheses[0].verification_status, HypothesisStatus.REJECTED
        )
        self.assertEqual(report.evidence[0].stance, EvidenceStance.CONTRADICTING)
        self.assertEqual(report.evidence[0].recovery_ratio, 0.0)

    def test_control_damage_makes_recovery_inconclusive(self) -> None:
        raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        fixtures = raw["mock_ablation_results_by_segment"]
        assert isinstance(fixtures, dict)
        results = fixtures["missing_information_policy"]
        assert isinstance(results, list)
        for item in results:
            assert isinstance(item, dict)
            if item["test_case_id"] in {
                "case_control_hours",
                "case_control_shipping",
            }:
                metrics = item["metrics"]
                assert isinstance(metrics, list)
                metric = metrics[0]
                assert isinstance(metric, dict)
                metric["score"] = 0.7
        report = DiagnosisPipeline().run(parse_bundle(raw))

        self.assertEqual(
            report.hypotheses[0].verification_status,
            HypothesisStatus.INCONCLUSIVE,
        )
        self.assertEqual(report.evidence[0].stance, EvidenceStance.CONTRADICTING)
        self.assertAlmostEqual(report.evidence[0].control_mean_delta, -0.2)

    def test_no_regression_produces_no_root_cause_claim(self) -> None:
        raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        baseline_run = raw["baseline_eval_run"]
        candidate_run = raw["candidate_eval_run"]
        assert isinstance(baseline_run, dict)
        assert isinstance(candidate_run, dict)
        baseline_results = baseline_run["results"]
        candidate_results = candidate_run["results"]
        assert isinstance(baseline_results, list)
        assert isinstance(candidate_results, list)
        baseline_by_case = {
            item["test_case_id"]: item for item in baseline_results if isinstance(item, dict)
        }
        for candidate in candidate_results:
            assert isinstance(candidate, dict)
            baseline = baseline_by_case[candidate["test_case_id"]]
            candidate["passed"] = baseline["passed"]
            candidate["metrics"] = baseline["metrics"]
        report = DiagnosisPipeline().run(parse_bundle(raw))

        self.assertEqual(report.regression.cases, ())
        self.assertEqual(report.failure_clusters, ())
        self.assertEqual(report.hypotheses, ())
        self.assertEqual(report.evidence, ())

    def test_support_requires_the_declared_control_sample(self) -> None:
        raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        raw["detection"]["min_control_cases"] = 3
        report = DiagnosisPipeline().run(parse_bundle(raw))

        self.assertEqual(
            report.hypotheses[0].verification_status,
            HypothesisStatus.INCONCLUSIVE,
        )

    def test_support_requires_every_hard_target_to_recover(self) -> None:
        raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        results = raw["mock_ablation_results_by_segment"][
            "missing_information_policy"
        ]
        for item in results:
            if item["test_case_id"] == "case_missing_city":
                item["passed"] = False
        report = DiagnosisPipeline().run(parse_bundle(raw))

        self.assertEqual(
            report.hypotheses[0].verification_status,
            HypothesisStatus.INCONCLUSIVE,
        )
        self.assertIn("unrecovered_hard_targets=1", report.evidence[0].rationale)
        self.assertEqual(report.evidence[0].unrecovered_hard_targets, 1)

    def test_support_uses_worst_control_damage_not_a_canceling_mean(self) -> None:
        raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        results = raw["mock_ablation_results_by_segment"][
            "missing_information_policy"
        ]
        control_scores = {
            "case_control_hours": 0.8,
            "case_control_shipping": 1.0,
        }
        for item in results:
            if item["test_case_id"] in control_scores:
                item["metrics"][0]["score"] = control_scores[item["test_case_id"]]
        report = DiagnosisPipeline().run(parse_bundle(raw))

        self.assertAlmostEqual(report.evidence[0].control_mean_delta, 0.0)
        self.assertEqual(
            report.hypotheses[0].verification_status,
            HypothesisStatus.INCONCLUSIVE,
        )
        self.assertIn("max_control_damage=0.100000", report.evidence[0].rationale)
        self.assertAlmostEqual(
            report.evidence[0].max_observed_control_damage, 0.1
        )

    def test_support_rejects_a_new_control_pass_failure(self) -> None:
        raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        results = raw["mock_ablation_results_by_segment"][
            "missing_information_policy"
        ]
        for item in results:
            if item["test_case_id"] == "case_control_hours":
                item["passed"] = False
        report = DiagnosisPipeline().run(parse_bundle(raw))

        self.assertEqual(report.evidence[0].new_control_failures, 1)
        self.assertEqual(
            report.hypotheses[0].verification_status,
            HypothesisStatus.INCONCLUSIVE,
        )

    def test_rejects_confounding_ablation_runner_snapshot(self) -> None:
        class ConfoundedRunner:
            name = "confounded-test-runner"
            version = "1"

            def run(self, plan, variant, bundle):
                run = FixtureAblationRunner().run(plan, variant, bundle)
                return replace(
                    run,
                    eval_run=replace(
                        run.eval_run,
                        model_snapshot={"provider": "other", "model": "changed"},
                    ),
                )

        with self.assertRaisesRegex(PipelineInvariantError, "model_snapshot differs"):
            DiagnosisPipeline(ablation_runner=ConfoundedRunner()).run(
                load_bundle(EXAMPLE)
            )

    def test_rejects_duplicate_case_from_ablation_runner(self) -> None:
        class DuplicateCaseRunner:
            name = "duplicate-case-test-runner"
            version = "1"

            def run(self, plan, variant, bundle):
                run = FixtureAblationRunner().run(plan, variant, bundle)
                duplicate = replace(run.eval_run.results[0], id="extra_result")
                return replace(
                    run,
                    eval_run=replace(
                        run.eval_run,
                        results=(*run.eval_run.results, duplicate),
                    ),
                )

        with self.assertRaisesRegex(PipelineInvariantError, "test_case_ids.*duplicates"):
            DiagnosisPipeline(ablation_runner=DuplicateCaseRunner()).run(
                load_bundle(EXAMPLE)
            )

    def test_rejects_cluster_with_mismatched_case_references(self) -> None:
        class MismatchedClusterer:
            name = "mismatched-test-clusterer"
            version = "1"

            def cluster(self, regression, bundle):
                cluster = MetadataFailureClusterer().cluster(regression, bundle)[0]
                return (replace(cluster, test_case_ids=("case_control_hours",)),)

        with self.assertRaisesRegex(
            PipelineInvariantError, "test cases do not match its regression cases"
        ):
            DiagnosisPipeline(failure_clusterer=MismatchedClusterer()).run(
                load_bundle(EXAMPLE)
            )

    def test_pipeline_hash_includes_strategy_configuration(self) -> None:
        bundle = load_bundle(EXAMPLE)
        one = DiagnosisPipeline(
            root_cause_strategy=RuleBasedRootCauseStrategy(
                max_hypotheses_per_cluster=1
            )
        ).run(bundle)
        three = DiagnosisPipeline(
            root_cause_strategy=RuleBasedRootCauseStrategy(
                max_hypotheses_per_cluster=3
            )
        ).run(bundle)

        self.assertNotEqual(one.pipeline.config_hash, three.pipeline.config_hash)

    def test_report_id_hashes_report_content_not_only_child_ids(self) -> None:
        class AlternateMechanism(RuleBasedRootCauseStrategy):
            def propose(self, clusters, changes, bundle):
                return tuple(
                    replace(item, mechanism=item.mechanism + " Alternate wording.")
                    for item in super().propose(clusters, changes, bundle)
                )

        bundle = load_bundle(EXAMPLE)
        original = DiagnosisPipeline().run(bundle)
        altered = DiagnosisPipeline(root_cause_strategy=AlternateMechanism()).run(
            bundle
        )

        self.assertEqual(original.hypotheses[0].id, altered.hypotheses[0].id)
        self.assertNotEqual(original.report_id, altered.report_id)

    def test_diff_handles_a_segment_added_only_to_candidate(self) -> None:
        raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        candidate = raw["candidate_prompt_version"]
        assert isinstance(candidate, dict)
        segments = candidate["segments"]
        assert isinstance(segments, list)
        segments.append(
            {
                "id": "candidate_only_rule",
                "kind": "policy",
                "content": "Always provide a direct answer.",
                "ordinal": 3,
                "semantic_tags": ["direct_answer"],
            }
        )
        bundle = parse_bundle(raw)
        changes = StableSegmentDiff().diff(
            bundle.baseline_prompt_version, bundle.candidate_prompt_version
        )

        added = [
            item
            for item in changes
            if item.segment_id == "candidate_only_rule"
        ]
        self.assertEqual(len(added), 1)
        self.assertEqual(added[0].change_type, PromptChangeType.ADDED)


    def test_reference_implementations_satisfy_runtime_ports(self) -> None:
        self.assertIsInstance(StableSegmentDiff(), SemanticDiffStrategy)
        self.assertIsInstance(MetadataFailureClusterer(), FailureClusterer)
        self.assertIsInstance(RuleBasedRootCauseStrategy(), RootCauseStrategy)
        self.assertIsInstance(SingleSegmentRevertStrategy(), AblationStrategy)
        self.assertIsInstance(FixtureAblationRunner(), AblationRunner)
        self.assertIsInstance(ThresholdEvidenceScorer(), EvidenceScorer)


class BundleValidationTest(unittest.TestCase):
    def _raw_example(self) -> dict[str, object]:
        return json.loads(EXAMPLE.read_text(encoding="utf-8"))

    def test_rejects_unpaired_candidate_results(self) -> None:
        raw = self._raw_example()
        candidate = raw["candidate_eval_run"]
        assert isinstance(candidate, dict)
        results = candidate["results"]
        assert isinstance(results, list)
        results.pop()
        with self.assertRaisesRegex(BundleValidationError, "cover the dataset exactly"):
            parse_bundle(raw)

    def test_rejects_changed_model_snapshot_as_a_confounder(self) -> None:
        raw = self._raw_example()
        candidate = raw["candidate_eval_run"]
        assert isinstance(candidate, dict)
        snapshot = candidate["model_snapshot"]
        assert isinstance(snapshot, dict)
        snapshot["temperature"] = 0.7
        with self.assertRaisesRegex(BundleValidationError, "model_snapshot must match"):
            parse_bundle(raw)

    def test_rejects_tampered_prompt_content_hash(self) -> None:
        raw = self._raw_example()
        candidate = raw["candidate_prompt_version"]
        assert isinstance(candidate, dict)
        candidate["content_hash"] = "0" * 64
        with self.assertRaisesRegex(BundleValidationError, "content_hash does not match"):
            parse_bundle(raw)

    def test_rejects_unknown_contract_version(self) -> None:
        raw = self._raw_example()
        raw["schema_version"] = "prompt-regression.bundle/v99"
        with self.assertRaisesRegex(BundleValidationError, "schema_version must be"):
            parse_bundle(raw)

    def test_rejects_unknown_modeled_field(self) -> None:
        raw = self._raw_example()
        raw["surprise"] = "must not be silently ignored"
        with self.assertRaisesRegex(BundleValidationError, "unknown fields"):
            parse_bundle(raw)

    def test_rejects_non_finite_metadata(self) -> None:
        raw = self._raw_example()
        project = raw["project"]
        assert isinstance(project, dict)
        dataset = raw["dataset"]
        assert isinstance(dataset, dict)
        cases = dataset["test_cases"]
        assert isinstance(cases, list)
        case = cases[0]
        assert isinstance(case, dict)
        metadata = case["metadata"]
        assert isinstance(metadata, dict)
        metadata["bad_number"] = float("nan")
        with self.assertRaisesRegex(BundleValidationError, "NaN or infinity"):
            parse_bundle(raw)

    def test_file_loader_rejects_duplicate_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "duplicate.json"
            path.write_text(
                '{"schema_version":"prompt-regression.bundle/v1alpha1",'
                '"schema_version":"prompt-regression.bundle/v1alpha1"}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(BundleValidationError, "duplicate JSON object key"):
                load_bundle(path)

    def test_parser_requires_all_schema_required_detection_fields(self) -> None:
        raw = self._raw_example()
        detection = raw["detection"]
        assert isinstance(detection, dict)
        del detection["min_control_cases"]

        with self.assertRaisesRegex(BundleValidationError, "min_control_cases is required"):
            parse_bundle(raw)

    def test_parser_requires_schema_required_semantic_tags(self) -> None:
        raw = self._raw_example()
        candidate = raw["candidate_prompt_version"]
        assert isinstance(candidate, dict)
        segments = candidate["segments"]
        assert isinstance(segments, list)
        segment = segments[0]
        assert isinstance(segment, dict)
        del segment["semantic_tags"]

        with self.assertRaisesRegex(BundleValidationError, "semantic_tags is required"):
            parse_bundle(raw)

    def test_parser_enforces_schema_id_pattern(self) -> None:
        raw = self._raw_example()
        raw["bundle_id"] = "contains whitespace"

        with self.assertRaisesRegex(BundleValidationError, "must not contain whitespace"):
            parse_bundle(raw)

    def test_parser_enforces_normalized_metric_contract(self) -> None:
        raw = self._raw_example()
        baseline = raw["baseline_eval_run"]
        assert isinstance(baseline, dict)
        results = baseline["results"]
        assert isinstance(results, list)
        result = results[0]
        assert isinstance(result, dict)
        metrics = result["metrics"]
        assert isinstance(metrics, list)
        metric = metrics[0]
        assert isinstance(metric, dict)
        metric["score"] = 1.01

        with self.assertRaisesRegex(BundleValidationError, "score must be <= 1.0"):
            parse_bundle(raw)

    def test_prompt_hash_is_canonical_by_ordinal_not_input_array_order(self) -> None:
        original_raw = self._raw_example()
        shuffled_raw = self._raw_example()
        candidate = shuffled_raw["candidate_prompt_version"]
        assert isinstance(candidate, dict)
        segments = candidate["segments"]
        assert isinstance(segments, list)
        segments.reverse()

        original = parse_bundle(original_raw)
        shuffled = parse_bundle(shuffled_raw)

        self.assertEqual(
            original.candidate_prompt_version.content_hash,
            shuffled.candidate_prompt_version.content_hash,
        )


class CliTest(unittest.TestCase):
    def test_validate_and_diagnose_commands(self) -> None:
        self.assertEqual(main(["validate", str(EXAMPLE)]), 0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            code = main(
                [
                    "diagnose",
                    str(EXAMPLE),
                    "--out",
                    str(output),
                    "--require-supported-hypothesis",
                ]
            )
            self.assertEqual(code, 0)
            parsed = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                parsed["schema_version"], "prompt-regression.report/v1alpha1"
            )
            self.assertEqual(parsed["hypotheses"][0]["verification_status"], "supported")

    def test_validate_accepts_bundle_on_standard_input(self) -> None:
        output = StringIO()
        with patch("sys.stdin", StringIO(EXAMPLE.read_text(encoding="utf-8"))), redirect_stdout(
            output
        ):
            code = main(["validate", "-"])
        self.assertEqual(code, 0)
        self.assertIn("valid: bundle_missing_information_v1_v2", output.getvalue())

    def test_diagnose_can_write_a_human_readable_report(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "diagnosis.md"
            code = main(
                ["diagnose", str(EXAMPLE), "--format", "markdown", "--out", str(output)]
            )

            self.assertEqual(code, 0)
            rendered = output.read_text(encoding="utf-8")
            self.assertIn("# Prompt regression diagnosis", rendered)
            self.assertIn("SUPPORTED by controlled evidence", rendered)


if __name__ == "__main__":
    unittest.main()

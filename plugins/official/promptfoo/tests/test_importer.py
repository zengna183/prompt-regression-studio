from __future__ import annotations

from copy import deepcopy
from contextlib import redirect_stderr
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import warnings

from prompt_regression_core import DiagnosisPipeline
from prompt_regression_core.ports import EvalImporter
from prompt_regression_importer_promptfoo import (
    IMPORT_SCHEMA_VERSION,
    PromptfooConfounderError,
    PromptfooExecutionError,
    PromptfooImporter,
    PromptfooPairingError,
    PromptfooSchemaError,
    PromptfooSelectionError,
    PromptfooVersionError,
    plugin,
)
from prompt_regression_importer_promptfoo.cli import (
    EXIT_IMPORT_ERROR,
    EXIT_OK,
    EXIT_OUTPUT_ERROR,
    main,
)
from prompt_regression_plugin_sdk import (
    InProcessPluginWarning,
    InProcessTrust,
    PluginKind,
    load_manifest,
    load_plugin,
)


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = PLUGIN_ROOT / "tests" / "fixtures"


def _fixture(name: str) -> dict[str, object]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _request() -> dict[str, object]:
    model_config = {
        "provider_id": "openai:chat:redacted-model",
        "temperature": 0,
        "seed": 7,
    }
    evaluator_config = {
        "judge_provider_id": "openai:chat:redacted-judge",
        "rubric_revision": "redacted-r1",
    }
    return {
        "schema_version": IMPORT_SCHEMA_VERSION,
        "bundle_id": "bundle_promptfoo_redacted_v1_v2",
        "diagnosis_requested_at": "2026-09-14T08:10:00Z",
        "project": {"id": "project_redacted", "name": "Redacted Project"},
        "prompt": {
            "id": "prompt_support",
            "project_id": "project_redacted",
            "name": "Support prompt",
        },
        "dataset": {
            "id": "dataset_redacted",
            "project_id": "project_redacted",
            "name": "Redacted paired suite",
        },
        "baseline": {
            "export": _fixture("baseline-v3.redacted.json"),
            "selection": {
                "prompt_idx": 0,
                "provider_id": "openai:chat:redacted-model",
            },
            "prompt_version": {
                "id": "prompt_support_v1",
                "prompt_id": "prompt_support",
                "version": 1,
                "segments": [
                    {
                        "id": "role",
                        "kind": "system",
                        "content": "You are a support assistant.",
                        "ordinal": 0,
                        "semantic_tags": ["support"],
                    },
                    {
                        "id": "missing_information_policy",
                        "kind": "policy",
                        "content": "Ask for required information before answering.",
                        "ordinal": 1,
                        "semantic_tags": ["groundedness", "unsupported_assumption"],
                    },
                ],
            },
            "model_config": deepcopy(model_config),
            "evaluator_config": deepcopy(evaluator_config),
        },
        "candidate": {
            "export": _fixture("candidate-v3.redacted.json"),
            "selection": {
                "prompt_idx": 0,
                "provider_id": "openai:chat:redacted-model",
            },
            "prompt_version": {
                "id": "prompt_support_v2",
                "prompt_id": "prompt_support",
                "version": 2,
                "segments": [
                    {
                        "id": "role",
                        "kind": "system",
                        "content": "You are a support assistant.",
                        "ordinal": 0,
                        "semantic_tags": ["support"],
                    },
                    {
                        "id": "missing_information_policy",
                        "kind": "policy",
                        "content": "Give the most likely answer immediately.",
                        "ordinal": 1,
                        "semantic_tags": ["groundedness", "unsupported_assumption"],
                    },
                ],
            },
            "model_config": deepcopy(model_config),
            "evaluator_config": deepcopy(evaluator_config),
        },
        "detection": {
            "primary_metric": "groundedness",
            "metric_drop_threshold": 0.2,
            "min_target_cases": 2,
            "min_control_cases": 1,
        },
    }


class PromptfooImporterTest(unittest.TestCase):
    def test_imports_v3_and_preserves_evidence_provenance(self) -> None:
        bundle = PromptfooImporter().import_bundle(_request())

        self.assertEqual(len(bundle.dataset.test_cases), 3)
        self.assertEqual(len(bundle.baseline_eval_run.results), 3)
        self.assertEqual(len(bundle.candidate_eval_run.results), 3)
        self.assertEqual(bundle.mock_ablation_results_by_segment, {})
        self.assertEqual(
            bundle.baseline_eval_run.model_snapshot,
            bundle.candidate_eval_run.model_snapshot,
        )
        self.assertEqual(
            bundle.baseline_eval_run.evaluator_snapshot,
            bundle.candidate_eval_run.evaluator_snapshot,
        )

        candidate = bundle.candidate_eval_run.results_by_case()
        first_case_id = bundle.dataset.test_cases[0].id
        first = candidate[first_case_id]
        self.assertEqual(first.metadata["failure_mode"], "unsupported_assumption")
        source = first.metadata["promptfoo"]
        self.assertEqual(source["eval_id"], "eval-redacted-candidate")
        self.assertEqual(source["result_id"], "result-redacted-c-0")
        self.assertEqual(source["trace_id"], "trace-redacted-c-0")
        self.assertEqual(source["evaluation_id"], "evaluation-redacted-c")
        self.assertIn("invents an unavailable tier", first.metric("groundedness").reason or "")
        self.assertEqual(first.metric("promptfoo.overall").score, 0.27)
        self.assertFalse(first.metric("promptfoo.overall").passed)

        # `failure_mode` is never guessed from score/reason for the control row.
        control_case_id = bundle.dataset.test_cases[2].id
        self.assertNotIn("failure_mode", candidate[control_case_id].metadata)

        report = DiagnosisPipeline().run(bundle)
        self.assertEqual(len(report.regression.cases), 2)
        self.assertEqual(report.failure_clusters[0].key, "unsupported_assumption")
        self.assertEqual(report.evidence, ())

    def test_json_text_entry_point_is_deterministic(self) -> None:
        request = _request()
        first = PromptfooImporter().loads(json.dumps(request))
        second = PromptfooImporter().import_bundle(json.dumps(request))
        self.assertEqual(first, second)

    def test_rejects_v1_v2_unknown_and_non_integer_versions(self) -> None:
        for version in (1, 2, 4, 99, "3"):
            with self.subTest(version=version):
                request = _request()
                baseline = request["baseline"]
                assert isinstance(baseline, dict)
                export = baseline["export"]
                assert isinstance(export, dict)
                summary = export["results"]
                assert isinstance(summary, dict)
                summary["version"] = version
                with self.assertRaises(PromptfooVersionError):
                    PromptfooImporter().import_bundle(request)

    def test_rejects_selected_execution_error_with_message(self) -> None:
        request = _request()
        candidate = request["candidate"]
        assert isinstance(candidate, dict)
        export = candidate["export"]
        assert isinstance(export, dict)
        summary = export["results"]
        assert isinstance(summary, dict)
        rows = summary["results"]
        assert isinstance(rows, list)
        row = rows[0]
        assert isinstance(row, dict)
        row["error"] = "[REDACTED PROVIDER ERROR]"
        row["failureReason"] = 2
        with self.assertRaisesRegex(PromptfooExecutionError, "execution error"):
            PromptfooImporter().import_bundle(request)

    def test_failure_reason_two_cannot_masquerade_as_assertion_failure(self) -> None:
        request = _request()
        baseline = request["baseline"]
        assert isinstance(baseline, dict)
        export = baseline["export"]
        assert isinstance(export, dict)
        summary = export["results"]
        assert isinstance(summary, dict)
        rows = summary["results"]
        assert isinstance(rows, list)
        row = rows[0]
        assert isinstance(row, dict)
        row["success"] = False
        row["failureReason"] = 2
        row["error"] = None
        with self.assertRaisesRegex(PromptfooExecutionError, "failureReason=2"):
            PromptfooImporter().import_bundle(request)

    def test_rejects_ambiguous_multi_prompt_selection(self) -> None:
        request = _request()
        baseline = request["baseline"]
        assert isinstance(baseline, dict)
        baseline.pop("selection")
        export = baseline["export"]
        assert isinstance(export, dict)
        summary = export["results"]
        assert isinstance(summary, dict)
        prompts = summary["prompts"]
        rows = summary["results"]
        assert isinstance(prompts, list)
        assert isinstance(rows, list)
        prompts.append(
            {
                "id": "promptfoo-redacted-other",
                "label": "other-redacted",
                "raw": "[REDACTED OTHER PROMPT]",
                "provider": "openai:chat:redacted-model",
            }
        )
        other = deepcopy(rows[0])
        assert isinstance(other, dict)
        other["id"] = "result-redacted-other"
        other["promptIdx"] = 1
        other["promptId"] = "promptfoo-redacted-other"
        other["prompt"] = {
            "raw": "[REDACTED OTHER PROMPT]",
            "label": "other-redacted",
        }
        rows.append(other)
        with self.assertRaisesRegex(PromptfooSelectionError, "ambiguous"):
            PromptfooImporter().import_bundle(request)

    def test_rejects_incomplete_pairing(self) -> None:
        request = _request()
        candidate = request["candidate"]
        assert isinstance(candidate, dict)
        export = candidate["export"]
        assert isinstance(export, dict)
        summary = export["results"]
        assert isinstance(summary, dict)
        rows = summary["results"]
        assert isinstance(rows, list)
        rows.pop()
        with self.assertRaisesRegex(PromptfooPairingError, "same testIdx"):
            PromptfooImporter().import_bundle(request)

    def test_rejects_model_or_evaluator_confounders(self) -> None:
        cases = (("model_config", "model_config differ"), ("evaluator_config", "evaluator_config differ"))
        for field, expected in cases:
            with self.subTest(field=field):
                request = _request()
                candidate = request["candidate"]
                assert isinstance(candidate, dict)
                config = candidate[field]
                assert isinstance(config, dict)
                config["changed"] = True
                with self.assertRaisesRegex(PromptfooConfounderError, expected):
                    PromptfooImporter().import_bundle(request)

    def test_same_provider_id_with_changed_provider_object_is_a_confounder(self) -> None:
        request = _request()
        candidate = request["candidate"]
        assert isinstance(candidate, dict)
        export = candidate["export"]
        assert isinstance(export, dict)
        summary = export["results"]
        assert isinstance(summary, dict)
        rows = summary["results"]
        assert isinstance(rows, list)
        for row in rows:
            assert isinstance(row, dict)
            provider = row["provider"]
            assert isinstance(provider, dict)
            provider["label"] = "Different provider alias"
        with self.assertRaisesRegex(PromptfooConfounderError, "complete provider objects"):
            PromptfooImporter().import_bundle(request)

    def test_rejects_test_case_and_metric_contract_changes(self) -> None:
        for mutation, expected in (
            ("test_case", PromptfooPairingError),
            ("metric", PromptfooConfounderError),
        ):
            with self.subTest(mutation=mutation):
                request = _request()
                candidate = request["candidate"]
                assert isinstance(candidate, dict)
                export = candidate["export"]
                assert isinstance(export, dict)
                summary = export["results"]
                assert isinstance(summary, dict)
                rows = summary["results"]
                assert isinstance(rows, list)
                row = rows[0]
                assert isinstance(row, dict)
                if mutation == "test_case":
                    test_case = row["testCase"]
                    assert isinstance(test_case, dict)
                    test_case["description"] = "changed evaluator input"
                else:
                    scores = row["namedScores"]
                    assert isinstance(scores, dict)
                    scores["new_metric"] = 0.5
                with self.assertRaises(expected):
                    PromptfooImporter().import_bundle(request)

    def test_rejects_missing_primary_metric(self) -> None:
        request = _request()
        detection = request["detection"]
        assert isinstance(detection, dict)
        detection["primary_metric"] = "not_exported"
        with self.assertRaisesRegex(PromptfooSchemaError, "missing primary metric"):
            PromptfooImporter().import_bundle(request)


class PluginManifestTest(unittest.TestCase):
    def test_manifest_validates_and_loads_ready_instance(self) -> None:
        manifest = load_manifest(PLUGIN_ROOT / "prompt-regression-plugin.json")
        self.assertEqual(manifest.entry_points[0].target, "prompt_regression_importer_promptfoo:plugin")
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            loaded = load_plugin(
                manifest,
                PluginKind.EVAL_IMPORTER,
                core_version="0.1.0a1",
                trust=InProcessTrust.ACKNOWLEDGED,
            )
        self.assertIs(loaded.instance, plugin)
        self.assertIsInstance(loaded.instance, EvalImporter)
        self.assertTrue(any(item.category is InProcessPluginWarning for item in caught))


class CliTest(unittest.TestCase):
    def test_stdin_to_atomic_output_file(self) -> None:
        payload = json.dumps(_request())
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "bundle.json"
            with patch("sys.stdin", StringIO(payload)):
                code = main(["-", "--out", str(output)])
            self.assertEqual(code, EXIT_OK)
            bundle = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                bundle["schema_version"], "prompt-regression.bundle/v1alpha1"
            )
            self.assertEqual(bundle["bundle_id"], "bundle_promptfoo_redacted_v1_v2")
            self.assertEqual(list(Path(directory).glob(".*.tmp")), [])

    def test_import_and_output_errors_have_stable_exit_codes(self) -> None:
        bad_request = _request()
        baseline = bad_request["baseline"]
        assert isinstance(baseline, dict)
        export = baseline["export"]
        assert isinstance(export, dict)
        summary = export["results"]
        assert isinstance(summary, dict)
        summary["version"] = 2
        errors = StringIO()
        with patch("sys.stdin", StringIO(json.dumps(bad_request))), redirect_stderr(errors):
            code = main(["-"])
        self.assertEqual(code, EXIT_IMPORT_ERROR)
        self.assertIn("promptfoo_unsupported_version", errors.getvalue())

        valid_payload = json.dumps(_request())
        errors = StringIO()
        with tempfile.TemporaryDirectory() as directory:
            impossible = Path(directory) / "missing" / "bundle.json"
            with patch("sys.stdin", StringIO(valid_payload)), redirect_stderr(errors):
                code = main(["-", "--out", str(impossible)])
        self.assertEqual(code, EXIT_OUTPUT_ERROR)
        self.assertIn("output I/O error", errors.getvalue())


if __name__ == "__main__":
    unittest.main()

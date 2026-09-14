"""Original adapter for Promptfoo JSON output envelopes.

This module deliberately treats imports as a controlled-experiment boundary.
It will not turn provider or grader execution errors into ordinary failed cases,
and it will not compare runs whose model, evaluator, or test contracts differ.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

from prompt_regression_core import (
    RegressionBundle,
    canonical_json,
    content_hash,
    parse_bundle,
    stable_id,
)
from prompt_regression_core.ports import EvalImporter

from .errors import (
    PromptfooConfounderError,
    PromptfooExecutionError,
    PromptfooImportError,
    PromptfooPairingError,
    PromptfooSchemaError,
    PromptfooSelectionError,
    PromptfooVersionError,
)


IMPORT_SCHEMA_VERSION = "prompt-regression.import.promptfoo/v1alpha1"
ADAPTER_NAME = "prompt-regression-importer-promptfoo"
ADAPTER_VERSION = "0.1.0a1"
PROMPTFOO_SUMMARY_VERSION = 3
OVERALL_METRIC_KEY = "promptfoo.overall"


@dataclass(frozen=True, slots=True)
class _Signature:
    prompt_idx: int
    prompt_id: str
    provider_id: str
    provider_label: str | None
    provider_fingerprint: str

    def describe(self) -> str:
        label = f", label={self.provider_label!r}" if self.provider_label else ""
        return (
            f"prompt_idx={self.prompt_idx}, prompt_id={self.prompt_id!r}, "
            f"provider_id={self.provider_id!r}{label}"
        )


@dataclass(frozen=True, slots=True)
class _SelectedExport:
    eval_id: str
    timestamp: str
    signature: _Signature
    provider: dict[str, Any]
    rows: tuple[dict[str, Any], ...]
    prompt_header: dict[str, Any]

    def by_test_idx(self) -> dict[int, dict[str, Any]]:
        return {_required_index(row, "testIdx", "$.row"): row for row in self.rows}


@dataclass(frozen=True, slots=True)
class _RunInput:
    prompt_version: dict[str, Any]
    selected: _SelectedExport
    model_config: dict[str, Any]
    evaluator_config: dict[str, Any]


class PromptfooImporter:
    """Convert one baseline and one candidate Promptfoo v3 export to Core."""

    def import_bundle(
        self, source: Mapping[str, Any] | str | bytes | bytearray
    ) -> RegressionBundle:
        """Import a parsed request or strict JSON text.

        Files are intentionally handled by :meth:`load`, so a string here is
        always JSON text and can never be confused with a filesystem path.
        """

        if isinstance(source, (str, bytes, bytearray)):
            return self.loads(source)
        return self._from_mapping(source)

    def loads(self, payload: str | bytes | bytearray) -> RegressionBundle:
        """Parse a request from JSON while rejecting duplicate keys and NaN."""

        try:
            raw = json.loads(
                payload,
                object_pairs_hook=_object_without_duplicate_keys,
                parse_constant=_reject_non_finite_constant,
            )
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            raise PromptfooSchemaError(f"invalid JSON: {error}") from error
        return self._from_mapping(_object(raw, "$"))

    def load(self, path: str | Path) -> RegressionBundle:
        """Read a UTF-8 import request from disk."""

        source = Path(path)
        try:
            payload = source.read_bytes()
        except OSError as error:
            raise PromptfooSchemaError(
                f"cannot read import request: {error}", path=str(source)
            ) from error
        return self.loads(payload)

    def _from_mapping(self, source: Mapping[str, Any]) -> RegressionBundle:
        request = _object(source, "$")
        _reject_unknown(
            request,
            {
                "schema_version",
                "bundle_id",
                "diagnosis_requested_at",
                "project",
                "prompt",
                "dataset",
                "baseline",
                "candidate",
                "detection",
            },
            "$",
        )
        schema_version = _required_string(request, "schema_version", "$")
        if schema_version != IMPORT_SCHEMA_VERSION:
            raise PromptfooVersionError(
                f"import request must use {IMPORT_SCHEMA_VERSION!r}; "
                f"received {schema_version!r}",
                path="$.schema_version",
            )

        project = _copy_project(_required_object(request, "project", "$"), "$.project")
        prompt = _copy_prompt(_required_object(request, "prompt", "$"), "$.prompt")
        dataset = _copy_dataset(_required_object(request, "dataset", "$"), "$.dataset")
        detection = _copy_detection(
            _required_object(request, "detection", "$"), "$.detection"
        )
        baseline = _parse_run_input(
            _required_object(request, "baseline", "$"), "$.baseline"
        )
        candidate = _parse_run_input(
            _required_object(request, "candidate", "$"), "$.candidate"
        )

        _assert_controlled_pair(baseline, candidate)
        test_cases, case_ids = _build_test_cases(
            dataset_id=_required_string(dataset, "id", "$.dataset"),
            baseline=baseline.selected,
        )
        evaluator_snapshot = _build_evaluator_snapshot(baseline)
        model_snapshot = _build_model_snapshot(baseline)

        baseline_run = _build_eval_run(
            baseline,
            run_role="baseline",
            dataset_id=dataset["id"],
            case_ids=case_ids,
            model_snapshot=model_snapshot,
            evaluator_snapshot=evaluator_snapshot,
        )
        candidate_run = _build_eval_run(
            candidate,
            run_role="candidate",
            dataset_id=dataset["id"],
            case_ids=case_ids,
            model_snapshot=model_snapshot,
            evaluator_snapshot=evaluator_snapshot,
        )

        requested_at_raw = request.get(
            "diagnosis_requested_at", candidate.selected.timestamp
        )
        requested_at = _string_value(
            requested_at_raw, "$.diagnosis_requested_at"
        )
        _require_timezone_timestamp(requested_at, "$.diagnosis_requested_at")

        canonical = {
            "schema_version": "prompt-regression.bundle/v1alpha1",
            "bundle_id": _required_string(request, "bundle_id", "$"),
            "diagnosis_requested_at": requested_at,
            "project": project,
            "prompt": prompt,
            "dataset": {**dataset, "test_cases": test_cases},
            "baseline_prompt_version": baseline.prompt_version,
            "candidate_prompt_version": candidate.prompt_version,
            "baseline_eval_run": baseline_run,
            "candidate_eval_run": candidate_run,
            "detection": detection,
            "mock_ablation_results_by_segment": {},
        }
        try:
            return parse_bundle(canonical)
        except Exception as error:
            # Core is the final authority for cross-object contract invariants.
            # Preserve its precise message while keeping one importer error type
            # at this integration boundary.
            raise PromptfooSchemaError(f"canonical bundle rejected: {error}") from error


def _parse_run_input(raw: Mapping[str, Any], path: str) -> _RunInput:
    value = _object(raw, path)
    _reject_unknown(
        value,
        {
            "export",
            "selection",
            "prompt_version",
            "model_config",
            "evaluator_config",
        },
        path,
    )
    export = _required_object(value, "export", path)
    selection_raw = value.get("selection")
    selection = (
        None
        if selection_raw is None
        else _copy_selection(_object(selection_raw, f"{path}.selection"), f"{path}.selection")
    )
    selected = _select_export(export, selection, f"{path}.export")
    prompt_version = _copy_prompt_version(
        _required_object(value, "prompt_version", path), f"{path}.prompt_version"
    )
    model_config = _json_object_copy(
        _required_object(value, "model_config", path), f"{path}.model_config"
    )
    evaluator_config = _json_object_copy(
        _required_object(value, "evaluator_config", path),
        f"{path}.evaluator_config",
    )
    if not model_config:
        raise PromptfooSchemaError("must not be empty", path=f"{path}.model_config")
    if not evaluator_config:
        raise PromptfooSchemaError(
            "must not be empty", path=f"{path}.evaluator_config"
        )
    return _RunInput(
        prompt_version=prompt_version,
        selected=selected,
        model_config=model_config,
        evaluator_config=evaluator_config,
    )


def _select_export(
    envelope: Mapping[str, Any], selection: Mapping[str, Any] | None, path: str
) -> _SelectedExport:
    eval_id = _required_string(envelope, "evalId", path)
    summary = _required_object(envelope, "results", path)
    version = summary.get("version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise PromptfooVersionError(
            "results.version must be the integer 3", path=f"{path}.results.version"
        )
    if version != PROMPTFOO_SUMMARY_VERSION:
        raise PromptfooVersionError(
            f"only EvaluateSummaryV3 is supported; received version {version}",
            path=f"{path}.results.version",
        )

    timestamp = _required_string(summary, "timestamp", f"{path}.results")
    _require_timezone_timestamp(timestamp, f"{path}.results.timestamp")
    prompts = _required_array(summary, "prompts", f"{path}.results")
    _required_object(summary, "stats", f"{path}.results")
    rows = _required_array(summary, "results", f"{path}.results")
    if not prompts:
        raise PromptfooSchemaError(
            "EvaluateSummaryV3.prompts must not be empty",
            path=f"{path}.results.prompts",
        )
    if not rows:
        raise PromptfooSchemaError(
            "EvaluateSummaryV3.results must not be empty",
            path=f"{path}.results.results",
        )

    parsed_rows: list[tuple[dict[str, Any], _Signature]] = []
    for index, raw_row in enumerate(rows):
        row_path = f"{path}.results.results[{index}]"
        row = _object(raw_row, row_path)
        signature = _row_signature(row, row_path)
        parsed_rows.append((row, signature))

    matches = [
        (row, signature)
        for row, signature in parsed_rows
        if _selection_matches(signature, selection)
    ]
    if not matches:
        raise PromptfooSelectionError(
            "selection matched no rows", path=f"{path}.results.results"
        )
    signatures = {signature for _, signature in matches}
    if len(signatures) != 1:
        choices = "; ".join(item.describe() for item in sorted(
            signatures,
            key=lambda item: (
                item.prompt_idx,
                item.prompt_id,
                item.provider_id,
                item.provider_label or "",
                item.provider_fingerprint,
            ),
        ))
        raise PromptfooSelectionError(
            "prompt/provider selection is ambiguous; provide enough of "
            f"selection.prompt_idx, prompt_id, provider_id, and provider_label. "
            f"Candidates: {choices}",
            path=f"{path}.results.results",
        )
    signature = next(iter(signatures))

    if signature.prompt_idx >= len(prompts):
        raise PromptfooSchemaError(
            f"promptIdx {signature.prompt_idx} is outside prompts array",
            path=f"{path}.results.prompts",
        )
    prompt_header = _object(
        prompts[signature.prompt_idx],
        f"{path}.results.prompts[{signature.prompt_idx}]",
    )
    header_id = prompt_header.get("id")
    if header_id is not None and _string_value(
        header_id, f"{path}.results.prompts[{signature.prompt_idx}].id"
    ) != signature.prompt_id:
        raise PromptfooSchemaError(
            "row promptId does not match prompts[promptIdx].id",
            path=f"{path}.results.prompts[{signature.prompt_idx}].id",
        )

    selected_rows = [row for row, _ in matches]
    test_indices: set[int] = set()
    for index, row in enumerate(selected_rows):
        row_path = f"{path}.results.results[selected:{index}]"
        _validate_selected_row(row, row_path)
        test_idx = _required_index(row, "testIdx", row_path)
        if test_idx in test_indices:
            raise PromptfooSelectionError(
                "multiple selected rows share the same testIdx; repeated or "
                "multi-cell exports need a narrower selection",
                path=f"{row_path}.testIdx",
            )
        test_indices.add(test_idx)

    first_provider = _json_object_copy(
        _required_object(selected_rows[0], "provider", f"{path}.results.results"),
        f"{path}.results.results[0].provider",
    )
    selected_rows.sort(key=lambda row: _required_index(row, "testIdx", path))
    return _SelectedExport(
        eval_id=eval_id,
        timestamp=timestamp,
        signature=signature,
        provider=first_provider,
        rows=tuple(selected_rows),
        prompt_header=_json_object_copy(prompt_header, f"{path}.results.prompts"),
    )


def _row_signature(row: Mapping[str, Any], path: str) -> _Signature:
    prompt_idx = _required_index(row, "promptIdx", path)
    _required_index(row, "testIdx", path)
    prompt_id = _required_string(row, "promptId", path)
    _required_object(row, "prompt", path)
    _required_object(row, "testCase", path)
    _required_object(row, "vars", path)
    provider = _required_object(row, "provider", path)
    provider_id = _required_string(provider, "id", f"{path}.provider")
    provider_label_raw = provider.get("label")
    provider_label = (
        None
        if provider_label_raw is None
        else _string_value(provider_label_raw, f"{path}.provider.label")
    )
    provider_copy = _json_object_copy(provider, f"{path}.provider")
    return _Signature(
        prompt_idx=prompt_idx,
        prompt_id=prompt_id,
        provider_id=provider_id,
        provider_label=provider_label,
        provider_fingerprint=content_hash(provider_copy),
    )


def _copy_selection(raw: Mapping[str, Any], path: str) -> dict[str, Any]:
    _reject_unknown(
        raw, {"prompt_idx", "prompt_id", "provider_id", "provider_label"}, path
    )
    if not raw:
        raise PromptfooSelectionError(
            "an explicit selection must contain at least one selector", path=path
        )
    result: dict[str, Any] = {}
    if "prompt_idx" in raw:
        result["prompt_idx"] = _index_value(raw["prompt_idx"], f"{path}.prompt_idx")
    for key in ("prompt_id", "provider_id", "provider_label"):
        if key in raw:
            result[key] = _string_value(raw[key], f"{path}.{key}")
    return result


def _selection_matches(
    signature: _Signature, selection: Mapping[str, Any] | None
) -> bool:
    if selection is None:
        return True
    return all(
        (
            key == "prompt_idx" and signature.prompt_idx == expected
            or key == "prompt_id" and signature.prompt_id == expected
            or key == "provider_id" and signature.provider_id == expected
            or key == "provider_label" and signature.provider_label == expected
        )
        for key, expected in selection.items()
    )


def _validate_selected_row(row: Mapping[str, Any], path: str) -> None:
    failure_reason = _required_index(row, "failureReason", path)
    if failure_reason not in {0, 1, 2}:
        raise PromptfooSchemaError(
            "failureReason must be 0, 1, or 2", path=f"{path}.failureReason"
        )

    error_raw = row.get("error")
    if error_raw is not None:
        error_text = _string_value(error_raw, f"{path}.error", allow_empty=True)
        if error_text.strip():
            raise PromptfooExecutionError(
                f"selected result contains an execution error: {error_text}", path=path
            )
    response_raw = row.get("response")
    response = (
        None
        if response_raw is None
        else _object(response_raw, f"{path}.response")
    )
    if response is not None and response.get("error") is not None:
        response_error = response["error"]
        if not isinstance(response_error, str) or response_error.strip():
            raise PromptfooExecutionError(
                "selected result response contains an execution error", path=path
            )
    grading_raw = row.get("gradingResult")
    grading = (
        None
        if grading_raw is None
        else _object(grading_raw, f"{path}.gradingResult")
    )
    if grading is not None and _contains_grader_error(grading):
        raise PromptfooExecutionError(
            "selected result contains gradingResult.metadata.graderError", path=path
        )
    if failure_reason == 2:
        raise PromptfooExecutionError(
            "failureReason=2 is an execution error, not an ordinary failed eval",
            path=path,
        )

    success = _required_bool(row, "success", path)
    expected_reason = 0 if success else 1
    if failure_reason != expected_reason:
        raise PromptfooSchemaError(
            f"success={success!r} is inconsistent with failureReason={failure_reason}",
            path=path,
        )
    _required_number(row, "score", path)
    named_scores = _required_object(row, "namedScores", path)
    _validate_named_scores(named_scores, f"{path}.namedScores")
    if OVERALL_METRIC_KEY in named_scores:
        raise PromptfooSchemaError(
            f"namedScores must not use reserved metric {OVERALL_METRIC_KEY!r}",
            path=f"{path}.namedScores",
        )
    if response is None or "output" not in response:
        raise PromptfooSchemaError(
            "a non-error selected result must contain response.output",
            path=f"{path}.response",
        )
    _validate_json_value(response["output"], f"{path}.response.output", set())

    if grading is not None:
        if "pass" in grading:
            grading_pass = _bool_value(grading["pass"], f"{path}.gradingResult.pass")
            if grading_pass != success:
                raise PromptfooSchemaError(
                    "gradingResult.pass must equal success", path=f"{path}.gradingResult"
                )
        if "score" in grading:
            _number_value(grading["score"], f"{path}.gradingResult.score")
        if "reason" in grading:
            _string_value(
                grading["reason"], f"{path}.gradingResult.reason", allow_empty=True
            )
        grading_named = grading.get("namedScores")
        if grading_named is not None:
            grading_named_object = _object(
                grading_named, f"{path}.gradingResult.namedScores"
            )
            _validate_named_scores(
                grading_named_object, f"{path}.gradingResult.namedScores"
            )
            for key, score in grading_named_object.items():
                if key in named_scores and float(named_scores[key]) != float(score):
                    raise PromptfooSchemaError(
                        f"named score {key!r} conflicts with gradingResult.namedScores",
                        path=f"{path}.namedScores.{key}",
                    )

    test_case = _required_object(row, "testCase", path)
    variables = _required_object(row, "vars", path)
    if "vars" in test_case and canonical_json(test_case["vars"]) != canonical_json(variables):
        raise PromptfooSchemaError(
            "row.vars must equal testCase.vars when both are present", path=path
        )
    metadata_raw = row.get("metadata")
    if metadata_raw is not None:
        _json_object_copy(_object(metadata_raw, f"{path}.metadata"), f"{path}.metadata")
    for key in ("id", "traceId", "evaluationId", "description"):
        if key in row and row[key] is not None:
            _string_value(row[key], f"{path}.{key}", allow_empty=(key == "description"))


def _contains_grader_error(grading: Mapping[str, Any]) -> bool:
    metadata = grading.get("metadata")
    if isinstance(metadata, Mapping) and metadata.get("graderError") is True:
        return True
    components = grading.get("componentResults")
    if components is None:
        return False
    if not isinstance(components, Sequence) or isinstance(
        components, (str, bytes, bytearray)
    ):
        return False
    return any(
        isinstance(component, Mapping) and _contains_grader_error(component)
        for component in components
    )


def _assert_controlled_pair(baseline: _RunInput, candidate: _RunInput) -> None:
    if canonical_json(baseline.model_config) != canonical_json(candidate.model_config):
        raise PromptfooConfounderError(
            "baseline and candidate model_config differ; prompt-only diagnosis "
            "requires an identical model configuration",
            path="$.candidate.model_config",
        )
    if baseline.selected.signature.provider_id != candidate.selected.signature.provider_id:
        raise PromptfooConfounderError(
            "baseline and candidate selected different provider ids",
            path="$.candidate.selection.provider_id",
        )
    if (
        baseline.selected.signature.provider_fingerprint
        != candidate.selected.signature.provider_fingerprint
    ):
        raise PromptfooConfounderError(
            "baseline and candidate selected different complete provider objects; "
            "the same provider id is not sufficient to prove equivalence",
            path="$.candidate.export.results.results[].provider",
        )
    if canonical_json(baseline.evaluator_config) != canonical_json(
        candidate.evaluator_config
    ):
        raise PromptfooConfounderError(
            "baseline and candidate evaluator_config differ",
            path="$.candidate.evaluator_config",
        )

    baseline_rows = baseline.selected.by_test_idx()
    candidate_rows = candidate.selected.by_test_idx()
    baseline_indices = set(baseline_rows)
    candidate_indices = set(candidate_rows)
    if baseline_indices != candidate_indices:
        raise PromptfooPairingError(
            "selected exports do not cover the same testIdx values; "
            f"missing_in_candidate={sorted(baseline_indices - candidate_indices)}, "
            f"extra_in_candidate={sorted(candidate_indices - baseline_indices)}",
            path="$.candidate.export.results.results",
        )

    for test_idx in sorted(baseline_indices):
        baseline_row = baseline_rows[test_idx]
        candidate_row = candidate_rows[test_idx]
        for field in ("testCase", "vars"):
            if canonical_json(baseline_row[field]) != canonical_json(candidate_row[field]):
                raise PromptfooPairingError(
                    f"testIdx {test_idx} has different {field} in baseline and candidate",
                    path=f"$.candidate.export.results.results[testIdx={test_idx}].{field}",
                )
        baseline_description = baseline_row.get("description")
        candidate_description = candidate_row.get("description")
        if baseline_description != candidate_description:
            raise PromptfooPairingError(
                f"testIdx {test_idx} has a different description",
                path=f"$.candidate.export.results.results[testIdx={test_idx}].description",
            )
        baseline_metrics = set(_required_object(baseline_row, "namedScores", "$"))
        candidate_metrics = set(_required_object(candidate_row, "namedScores", "$"))
        if baseline_metrics != candidate_metrics:
            raise PromptfooConfounderError(
                f"testIdx {test_idx} has different namedScores keys; evaluator "
                f"contract changed from {sorted(baseline_metrics)} to "
                f"{sorted(candidate_metrics)}",
                path=f"$.candidate.export.results.results[testIdx={test_idx}].namedScores",
            )


def _build_test_cases(
    *, dataset_id: str, baseline: _SelectedExport
) -> tuple[list[dict[str, Any]], dict[int, str]]:
    cases: list[dict[str, Any]] = []
    case_ids: dict[int, str] = {}
    for row in baseline.rows:
        test_idx = _required_index(row, "testIdx", "$.baseline.export")
        test_case = _json_object_copy(
            _required_object(row, "testCase", "$.baseline.export"),
            "$.baseline.export.testCase",
        )
        variables = _json_object_copy(
            _required_object(row, "vars", "$.baseline.export"),
            "$.baseline.export.vars",
        )
        case_id = stable_id(
            "case",
            {
                "source": "promptfoo",
                "dataset_id": dataset_id,
                "test_idx": test_idx,
                "test_case": test_case,
                "vars": variables,
            },
        )
        case_ids[test_idx] = case_id
        promptfoo_metadata: dict[str, Any] = {
            "test_idx": test_idx,
            "test_case": test_case,
        }
        if row.get("description") is not None:
            promptfoo_metadata["description"] = row["description"]
        cases.append(
            {
                "id": case_id,
                "input": variables,
                "expected": None,
                "metadata": {
                    "source": "promptfoo",
                    "promptfoo": promptfoo_metadata,
                },
            }
        )
    return cases, case_ids


def _build_eval_run(
    run: _RunInput,
    *,
    run_role: str,
    dataset_id: str,
    case_ids: Mapping[int, str],
    model_snapshot: Mapping[str, Any],
    evaluator_snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for row in run.selected.rows:
        test_idx = _required_index(row, "testIdx", f"$.{run_role}.export")
        results.append(
            _build_eval_result(
                row,
                eval_id=run.selected.eval_id,
                test_case_id=case_ids[test_idx],
                test_idx=test_idx,
                run_role=run_role,
            )
        )
    run_id = stable_id(
        "evalrun",
        {
            "source": "promptfoo",
            "eval_id": run.selected.eval_id,
            "role": run_role,
            "prompt_version_id": run.prompt_version["id"],
            "result_ids": [result["id"] for result in results],
        },
    )
    return {
        "id": run_id,
        "prompt_version_id": run.prompt_version["id"],
        "dataset_id": dataset_id,
        "results": results,
        "model_snapshot": dict(model_snapshot),
        "evaluator_snapshot": dict(evaluator_snapshot),
    }


def _build_eval_result(
    row: Mapping[str, Any],
    *,
    eval_id: str,
    test_case_id: str,
    test_idx: int,
    run_role: str,
) -> dict[str, Any]:
    upstream_result_id = row.get("id")
    result_id = stable_id(
        "evalresult",
        {
            "source": "promptfoo",
            "eval_id": eval_id,
            "upstream_result_id": upstream_result_id,
            "test_idx": test_idx,
            "role": run_role,
        },
    )
    response = _required_object(row, "response", "$.result")
    output = response["output"]
    output_text = output if isinstance(output, str) else canonical_json(output)
    grading = row.get("gradingResult")
    grading_object = grading if isinstance(grading, Mapping) else None
    assertion_facts = _collect_assertion_facts(grading_object)

    promptfoo_metadata: dict[str, Any] = {
        "eval_id": eval_id,
        "result_id": upstream_result_id,
        "test_idx": test_idx,
        "prompt_idx": row["promptIdx"],
        "prompt_id": row["promptId"],
        "provider": _json_object_copy(row["provider"], "$.result.provider"),
        "assertion_reasons": assertion_facts,
    }
    for source_key, target_key in (
        ("traceId", "trace_id"),
        ("evaluationId", "evaluation_id"),
    ):
        if row.get(source_key) is not None:
            promptfoo_metadata[target_key] = row[source_key]
    if grading_object is not None and grading_object.get("reason") is not None:
        promptfoo_metadata["grading_reason"] = grading_object["reason"]
    row_metadata = row.get("metadata")
    if isinstance(row_metadata, Mapping):
        promptfoo_metadata["metadata"] = _json_object_copy(
            row_metadata, "$.result.metadata"
        )

    metadata: dict[str, Any] = {
        "source": "promptfoo",
        "promptfoo": promptfoo_metadata,
    }
    failure_mode = _explicit_failure_mode(row)
    if failure_mode is not None:
        metadata["failure_mode"] = failure_mode

    return {
        "id": result_id,
        "test_case_id": test_case_id,
        "output_text": output_text,
        "passed": row["success"],
        "metrics": _build_metrics(row, assertion_facts),
        "metadata": metadata,
    }


def _build_metrics(
    row: Mapping[str, Any], assertion_facts: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    grading = row.get("gradingResult")
    overall_reason = (
        grading.get("reason")
        if isinstance(grading, Mapping) and isinstance(grading.get("reason"), str)
        else None
    )
    metrics: list[dict[str, Any]] = [
        {
            "metric_key": OVERALL_METRIC_KEY,
            "score": float(row["score"]),
            "passed": row["success"],
            "reason": overall_reason,
        }
    ]
    named_scores = _required_object(row, "namedScores", "$.result")
    for metric_key in sorted(named_scores):
        facts = [fact for fact in assertion_facts if fact.get("metric") == metric_key]
        reasons = [
            str(fact["reason"])
            for fact in facts
            if isinstance(fact.get("reason"), str) and str(fact["reason"]).strip()
        ]
        pass_values = [fact["passed"] for fact in facts if isinstance(fact.get("passed"), bool)]
        metrics.append(
            {
                "metric_key": metric_key,
                "score": float(named_scores[metric_key]),
                "passed": all(pass_values) if pass_values else None,
                "reason": " | ".join(reasons) if reasons else None,
            }
        )
    return metrics


def _collect_assertion_facts(
    grading: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    if grading is None:
        return []
    facts: list[dict[str, Any]] = []

    def visit(value: Mapping[str, Any], path: str) -> None:
        assertion = value.get("assertion")
        assertion_object = assertion if isinstance(assertion, Mapping) else {}
        fact: dict[str, Any] = {"path": path}
        for key, target in (
            ("type", "assertion_type"),
            ("metric", "metric"),
        ):
            if isinstance(assertion_object.get(key), str):
                fact[target] = assertion_object[key]
        if isinstance(value.get("reason"), str):
            fact["reason"] = value["reason"]
        if isinstance(value.get("pass"), bool):
            fact["passed"] = value["pass"]
        score = value.get("score")
        if isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(float(score)):
            fact["score"] = float(score)
        if len(fact) > 1:
            facts.append(fact)
        components = value.get("componentResults")
        if isinstance(components, Sequence) and not isinstance(
            components, (str, bytes, bytearray)
        ):
            for index, component in enumerate(components):
                if isinstance(component, Mapping):
                    visit(component, f"{path}.componentResults[{index}]")

    visit(grading, "gradingResult")
    return facts


def _explicit_failure_mode(row: Mapping[str, Any]) -> str | None:
    candidates: list[tuple[str, Any]] = []
    row_metadata = row.get("metadata")
    if isinstance(row_metadata, Mapping) and "failure_mode" in row_metadata:
        candidates.append(("metadata.failure_mode", row_metadata["failure_mode"]))
    test_case = row.get("testCase")
    if isinstance(test_case, Mapping):
        case_metadata = test_case.get("metadata")
        if isinstance(case_metadata, Mapping) and "failure_mode" in case_metadata:
            candidates.append(
                ("testCase.metadata.failure_mode", case_metadata["failure_mode"])
            )
    if not candidates:
        return None
    normalized: list[str] = []
    for path, value in candidates:
        normalized.append(_string_value(value, f"$.result.{path}").strip())
    if len(set(normalized)) != 1:
        raise PromptfooSchemaError(
            "conflicting explicit failure_mode values", path="$.result.metadata"
        )
    return normalized[0]


def _build_model_snapshot(run: _RunInput) -> dict[str, Any]:
    return {
        "source": "promptfoo",
        "provider_id": run.selected.signature.provider_id,
        "provider_fingerprint": run.selected.signature.provider_fingerprint,
        "selected_provider": run.selected.provider,
        "declared_model_config": run.model_config,
    }


def _build_evaluator_snapshot(run: _RunInput) -> dict[str, Any]:
    test_contracts: list[dict[str, Any]] = []
    metric_contracts: list[dict[str, Any]] = []
    for row in run.selected.rows:
        test_idx = _required_index(row, "testIdx", "$.baseline.export")
        test_contracts.append(
            {
                "test_idx": test_idx,
                "test_case": _json_object_copy(row["testCase"], "$.testCase"),
                "vars": _json_object_copy(row["vars"], "$.vars"),
            }
        )
        metric_contracts.append(
            {
                "test_idx": test_idx,
                "metric_keys": [
                    OVERALL_METRIC_KEY,
                    *sorted(_required_object(row, "namedScores", "$.result")),
                ],
            }
        )
    return {
        "source": "promptfoo",
        "adapter": ADAPTER_NAME,
        "adapter_version": ADAPTER_VERSION,
        "format": "EvaluateSummaryV3",
        "format_version": PROMPTFOO_SUMMARY_VERSION,
        "declared_evaluator_config": run.evaluator_config,
        "test_contract_hash": content_hash(test_contracts),
        "metric_contracts": metric_contracts,
    }


def _copy_project(raw: Mapping[str, Any], path: str) -> dict[str, Any]:
    _reject_unknown(raw, {"id", "name"}, path)
    return {
        "id": _required_string(raw, "id", path),
        "name": _required_string(raw, "name", path),
    }


def _copy_prompt(raw: Mapping[str, Any], path: str) -> dict[str, Any]:
    _reject_unknown(raw, {"id", "project_id", "name"}, path)
    return {
        "id": _required_string(raw, "id", path),
        "project_id": _required_string(raw, "project_id", path),
        "name": _required_string(raw, "name", path),
    }


def _copy_dataset(raw: Mapping[str, Any], path: str) -> dict[str, Any]:
    _reject_unknown(raw, {"id", "project_id", "name"}, path)
    return {
        "id": _required_string(raw, "id", path),
        "project_id": _required_string(raw, "project_id", path),
        "name": _required_string(raw, "name", path),
    }


def _copy_prompt_version(raw: Mapping[str, Any], path: str) -> dict[str, Any]:
    _reject_unknown(raw, {"id", "prompt_id", "version", "segments", "content_hash"}, path)
    version = _required_index(raw, "version", path)
    if version < 1:
        raise PromptfooSchemaError("must be >= 1", path=f"{path}.version")
    segments_raw = _required_array(raw, "segments", path)
    if not segments_raw:
        raise PromptfooSchemaError("must not be empty", path=f"{path}.segments")
    segments: list[dict[str, Any]] = []
    for index, segment_raw in enumerate(segments_raw):
        segment_path = f"{path}.segments[{index}]"
        segment = _object(segment_raw, segment_path)
        _reject_unknown(
            segment, {"id", "kind", "content", "ordinal", "semantic_tags"}, segment_path
        )
        tags_raw = segment.get("semantic_tags", [])
        tags = [
            _string_value(item, f"{segment_path}.semantic_tags[{tag_index}]")
            for tag_index, item in enumerate(_array_value(tags_raw, f"{segment_path}.semantic_tags"))
        ]
        segments.append(
            {
                "id": _required_string(segment, "id", segment_path),
                "kind": _required_string(segment, "kind", segment_path),
                "content": _required_string(segment, "content", segment_path),
                "ordinal": _required_index(segment, "ordinal", segment_path),
                "semantic_tags": tags,
            }
        )
    result: dict[str, Any] = {
        "id": _required_string(raw, "id", path),
        "prompt_id": _required_string(raw, "prompt_id", path),
        "version": version,
        "segments": segments,
    }
    if "content_hash" in raw:
        result["content_hash"] = _string_value(raw["content_hash"], f"{path}.content_hash")
    return result


def _copy_detection(raw: Mapping[str, Any], path: str) -> dict[str, Any]:
    allowed = {
        "primary_metric",
        "metric_drop_threshold",
        "min_target_cases",
        "min_control_cases",
        "support_recovery_ratio",
        "reject_recovery_ratio",
        "max_control_damage",
    }
    _reject_unknown(raw, allowed, path)
    # The canonical bundle makes every decision gate explicit. The importer
    # therefore expands omitted request fields to Core's reference defaults so
    # downstream reports record the actual thresholds instead of hidden policy.
    result: dict[str, Any] = {
        "primary_metric": _required_string(raw, "primary_metric", path),
        "metric_drop_threshold": 0.2,
        "min_target_cases": 2,
        "min_control_cases": 1,
        "support_recovery_ratio": 0.6,
        "reject_recovery_ratio": 0.1,
        "max_control_damage": 0.05,
    }
    for key in (
        "metric_drop_threshold",
        "support_recovery_ratio",
        "reject_recovery_ratio",
        "max_control_damage",
    ):
        if key in raw:
            result[key] = _number_value(raw[key], f"{path}.{key}")
    for key in ("min_target_cases", "min_control_cases"):
        if key in raw:
            result[key] = _index_value(raw[key], f"{path}.{key}")
    return result


def _validate_named_scores(raw: Mapping[str, Any], path: str) -> None:
    for key, value in raw.items():
        if not isinstance(key, str) or not key.strip():
            raise PromptfooSchemaError("metric keys must be non-empty strings", path=path)
        _number_value(value, f"{path}.{key}")


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def _reject_non_finite_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON number {value!r} is not permitted")


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise PromptfooSchemaError("must be an object", path=path)
    result = dict(value)
    if not all(isinstance(key, str) for key in result):
        raise PromptfooSchemaError("object keys must be strings", path=path)
    return result


def _required_object(
    value: Mapping[str, Any], key: str, path: str
) -> dict[str, Any]:
    if key not in value:
        raise PromptfooSchemaError("is required", path=f"{path}.{key}")
    return _object(value[key], f"{path}.{key}")


def _required_array(value: Mapping[str, Any], key: str, path: str) -> list[Any]:
    if key not in value:
        raise PromptfooSchemaError("is required", path=f"{path}.{key}")
    return _array_value(value[key], f"{path}.{key}")


def _array_value(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise PromptfooSchemaError("must be an array", path=path)
    return value


def _required_string(value: Mapping[str, Any], key: str, path: str) -> str:
    if key not in value:
        raise PromptfooSchemaError("is required", path=f"{path}.{key}")
    return _string_value(value[key], f"{path}.{key}")


def _string_value(value: Any, path: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise PromptfooSchemaError("must be a string", path=path)
    if not allow_empty and not value.strip():
        raise PromptfooSchemaError("must not be empty", path=path)
    return value


def _required_index(value: Mapping[str, Any], key: str, path: str) -> int:
    if key not in value:
        raise PromptfooSchemaError("is required", path=f"{path}.{key}")
    return _index_value(value[key], f"{path}.{key}")


def _index_value(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise PromptfooSchemaError("must be an integer", path=path)
    if value < 0:
        raise PromptfooSchemaError("must be >= 0", path=path)
    return value


def _required_number(value: Mapping[str, Any], key: str, path: str) -> float:
    if key not in value:
        raise PromptfooSchemaError("is required", path=f"{path}.{key}")
    return _number_value(value[key], f"{path}.{key}")


def _number_value(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PromptfooSchemaError("must be a number", path=path)
    result = float(value)
    if not math.isfinite(result):
        raise PromptfooSchemaError("must be finite", path=path)
    return result


def _required_bool(value: Mapping[str, Any], key: str, path: str) -> bool:
    if key not in value:
        raise PromptfooSchemaError("is required", path=f"{path}.{key}")
    return _bool_value(value[key], f"{path}.{key}")


def _bool_value(value: Any, path: str) -> bool:
    if not isinstance(value, bool):
        raise PromptfooSchemaError("must be a boolean", path=path)
    return value


def _reject_unknown(value: Mapping[str, Any], allowed: set[str], path: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise PromptfooSchemaError(f"contains unknown fields: {unknown!r}", path=path)


def _require_timezone_timestamp(value: str, path: str) -> None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PromptfooSchemaError("must be an ISO-8601 timestamp", path=path) from error
    if parsed.tzinfo is None:
        raise PromptfooSchemaError("must include a timezone", path=path)


def _json_object_copy(value: Mapping[str, Any], path: str) -> dict[str, Any]:
    copied = _json_copy(value, path, set())
    assert isinstance(copied, dict)
    return copied


def _json_copy(value: Any, path: str, active: set[int]) -> Any:
    _validate_json_value(value, path, active)
    if isinstance(value, Mapping):
        return {str(key): _json_copy(item, f"{path}.{key}", active) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_copy(item, f"{path}[{index}]", active) for index, item in enumerate(value)]
    return value


def _validate_json_value(value: Any, path: str, active: set[int]) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise PromptfooSchemaError("must be finite", path=path)
        return
    if isinstance(value, (list, Mapping)):
        identity = id(value)
        if identity in active:
            raise PromptfooSchemaError("must not contain cycles", path=path)
        active.add(identity)
        try:
            if isinstance(value, Mapping):
                for key, item in value.items():
                    if not isinstance(key, str):
                        raise PromptfooSchemaError("object keys must be strings", path=path)
                    _validate_json_value(item, f"{path}.{key}", active)
            else:
                for index, item in enumerate(value):
                    _validate_json_value(item, f"{path}[{index}]", active)
        finally:
            active.remove(identity)
        return
    raise PromptfooSchemaError(
        f"must be JSON-compatible, received {type(value).__name__}", path=path
    )


# Statically demonstrate that the adapter exposes the Core port without making
# Core import this package. This assignment is also checked by unit tests.
_PORT_CHECK: type[EvalImporter] = PromptfooImporter


__all__ = [
    "ADAPTER_NAME",
    "ADAPTER_VERSION",
    "IMPORT_SCHEMA_VERSION",
    "OVERALL_METRIC_KEY",
    "PROMPTFOO_SUMMARY_VERSION",
    "PromptfooImporter",
    "PromptfooImportError",
]

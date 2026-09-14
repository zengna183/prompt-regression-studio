"""Strict parser for the canonical `v1alpha1` regression bundle."""

from __future__ import annotations

from datetime import datetime
import json
import math
from pathlib import Path
import re
from typing import Any, Mapping

from .canonical import content_hash
from .errors import BundleValidationError
from .model import (
    Dataset,
    DetectionConfig,
    EvalResult,
    EvalRun,
    MetricResult,
    Project,
    Prompt,
    PromptSegment,
    PromptVersion,
    RegressionBundle,
    TestCase,
)


BUNDLE_SCHEMA_VERSION = "prompt-regression.bundle/v1alpha1"
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_RFC3339_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def load_bundle(path: str | Path) -> RegressionBundle:
    """Read and validate a bundle from UTF-8 JSON."""

    source = Path(path)
    try:
        payload = source.read_text(encoding="utf-8")
    except OSError as error:
        raise BundleValidationError(f"Cannot read bundle {source}: {error}") from error
    return loads_bundle(payload, source_label=str(source))


def loads_bundle(payload: str, *, source_label: str = "<memory>") -> RegressionBundle:
    """Validate a JSON string without requiring a filesystem boundary."""

    try:
        raw = json.loads(
            payload,
            object_pairs_hook=_object_without_duplicate_keys,
            parse_constant=_reject_non_finite_json_constant,
        )
    except json.JSONDecodeError as error:
        raise BundleValidationError(
            f"Bundle {source_label} is not valid JSON at line {error.lineno}, "
            f"column {error.colno}: {error.msg}"
        ) from error
    except ValueError as error:
        raise BundleValidationError(
            f"Bundle {source_label} is invalid: {error}"
        ) from error
    return parse_bundle(raw)


def parse_bundle(raw: Any) -> RegressionBundle:
    """Parse a Python JSON value and enforce cross-object invariants."""

    _validate_json_tree(raw, "$", set())
    root = _object(raw, "$")
    _reject_unknown(
        root,
        {
            "schema_version",
            "bundle_id",
            "diagnosis_requested_at",
            "project",
            "prompt",
            "dataset",
            "baseline_prompt_version",
            "candidate_prompt_version",
            "baseline_eval_run",
            "candidate_eval_run",
            "detection",
            "mock_ablation_results_by_segment",
        },
        "$",
    )
    schema_version = _string(root, "schema_version", "$")
    if schema_version != BUNDLE_SCHEMA_VERSION:
        raise BundleValidationError(
            f"$.schema_version must be {BUNDLE_SCHEMA_VERSION!r}; "
            f"received {schema_version!r}"
        )

    project = _parse_project(_object_field(root, "project", "$"), "$.project")
    prompt = _parse_prompt(_object_field(root, "prompt", "$"), "$.prompt")
    dataset = _parse_dataset(_object_field(root, "dataset", "$"), "$.dataset")
    baseline_prompt = _parse_prompt_version(
        _object_field(root, "baseline_prompt_version", "$"),
        "$.baseline_prompt_version",
    )
    candidate_prompt = _parse_prompt_version(
        _object_field(root, "candidate_prompt_version", "$"),
        "$.candidate_prompt_version",
    )
    baseline_run = _parse_eval_run(
        _object_field(root, "baseline_eval_run", "$"), "$.baseline_eval_run"
    )
    candidate_run = _parse_eval_run(
        _object_field(root, "candidate_eval_run", "$"), "$.candidate_eval_run"
    )
    detection = _parse_detection(
        _object_field(root, "detection", "$"), "$.detection"
    )
    mock_raw = _object_field(root, "mock_ablation_results_by_segment", "$")
    mock_results: dict[str, tuple[EvalResult, ...]] = {}
    for segment_id, value in mock_raw.items():
        _scalar_id(
            segment_id,
            "$.mock_ablation_results_by_segment property name",
        )
        result_values = _array(value, f"$.mock_ablation_results_by_segment.{segment_id}")
        mock_results[segment_id] = tuple(
            _parse_eval_result(
                item,
                f"$.mock_ablation_results_by_segment.{segment_id}[{index}]",
            )
            for index, item in enumerate(result_values)
        )

    requested_at = _string(root, "diagnosis_requested_at", "$")
    _validate_timestamp(requested_at, "$.diagnosis_requested_at")

    bundle = RegressionBundle(
        schema_version=schema_version,
        bundle_id=_id(root, "bundle_id", "$"),
        diagnosis_requested_at=requested_at,
        project=project,
        prompt=prompt,
        dataset=dataset,
        baseline_prompt_version=baseline_prompt,
        candidate_prompt_version=candidate_prompt,
        baseline_eval_run=baseline_run,
        candidate_eval_run=candidate_run,
        detection=detection,
        mock_ablation_results_by_segment=mock_results,
    )
    _validate_bundle_invariants(bundle)
    return bundle


def _parse_project(raw: Any, path: str) -> Project:
    value = _object(raw, path)
    _reject_unknown(value, {"id", "name"}, path)
    return Project(
        id=_id(value, "id", path),
        name=_bounded_string(value, "name", path, maximum=240),
    )


def _parse_prompt(raw: Any, path: str) -> Prompt:
    value = _object(raw, path)
    _reject_unknown(value, {"id", "project_id", "name"}, path)
    return Prompt(
        id=_id(value, "id", path),
        project_id=_id(value, "project_id", path),
        name=_bounded_string(value, "name", path, maximum=240),
    )


def _parse_prompt_segment(raw: Any, path: str) -> PromptSegment:
    value = _object(raw, path)
    _reject_unknown(value, {"id", "kind", "content", "ordinal", "semantic_tags"}, path)
    tags_raw = _array_field(value, "semantic_tags", path)
    tags = tuple(
        _bounded_scalar_string(
            item,
            f"{path}.semantic_tags[{index}]",
            maximum=120,
        )
        for index, item in enumerate(tags_raw)
    )
    if len(tags) != len(set(tags)):
        raise BundleValidationError(f"{path}.semantic_tags contains duplicates")
    return PromptSegment(
        id=_id(value, "id", path),
        kind=_bounded_string(value, "kind", path, maximum=80),
        content=_bounded_string(value, "content", path, maximum=100000),
        ordinal=_integer(value, "ordinal", path, minimum=0),
        semantic_tags=tags,
    )


def _prompt_segments_hash(segments: tuple[PromptSegment, ...]) -> str:
    return content_hash(
        [
            {
                "id": segment.id,
                "kind": segment.kind,
                "content": segment.content,
                "ordinal": segment.ordinal,
                "semantic_tags": list(segment.semantic_tags),
            }
            for segment in segments
        ]
    )


def _parse_prompt_version(raw: Any, path: str) -> PromptVersion:
    value = _object(raw, path)
    _reject_unknown(
        value, {"id", "prompt_id", "version", "segments", "content_hash"}, path
    )
    segment_values = _array_field(value, "segments", path)
    segments = tuple(
        _parse_prompt_segment(item, f"{path}.segments[{index}]")
        for index, item in enumerate(segment_values)
    )
    if not segments:
        raise BundleValidationError(f"{path}.segments must not be empty")
    _ensure_unique((segment.id for segment in segments), f"{path}.segments[].id")
    _ensure_unique((segment.ordinal for segment in segments), f"{path}.segments[].ordinal")
    canonical_segments = tuple(
        sorted(segments, key=lambda item: (item.ordinal, item.id))
    )
    calculated_hash = _prompt_segments_hash(canonical_segments)
    supplied_hash = value.get("content_hash")
    if supplied_hash is not None:
        supplied_hash = _scalar_string(supplied_hash, f"{path}.content_hash")
        if not _SHA256_PATTERN.fullmatch(supplied_hash):
            raise BundleValidationError(
                f"{path}.content_hash must be a lowercase SHA-256 digest"
            )
        if supplied_hash != calculated_hash:
            raise BundleValidationError(
                f"{path}.content_hash does not match the canonical segment content"
            )
    return PromptVersion(
        id=_id(value, "id", path),
        prompt_id=_id(value, "prompt_id", path),
        version=_integer(value, "version", path, minimum=1),
        segments=canonical_segments,
        content_hash=calculated_hash,
    )


def _parse_test_case(raw: Any, path: str) -> TestCase:
    value = _object(raw, path)
    _reject_unknown(value, {"id", "input", "expected", "metadata"}, path)
    expected_raw = value.get("expected")
    expected = None if expected_raw is None else _object(expected_raw, f"{path}.expected")
    return TestCase(
        id=_id(value, "id", path),
        input=_object_field(value, "input", path),
        expected=expected,
        metadata=_optional_object(value, "metadata", path),
    )


def _parse_dataset(raw: Any, path: str) -> Dataset:
    value = _object(raw, path)
    _reject_unknown(value, {"id", "project_id", "name", "test_cases"}, path)
    cases = tuple(
        _parse_test_case(item, f"{path}.test_cases[{index}]")
        for index, item in enumerate(_array_field(value, "test_cases", path))
    )
    if not cases:
        raise BundleValidationError(f"{path}.test_cases must not be empty")
    _ensure_unique((case.id for case in cases), f"{path}.test_cases[].id")
    return Dataset(
        id=_id(value, "id", path),
        project_id=_id(value, "project_id", path),
        name=_bounded_string(value, "name", path, maximum=240),
        test_cases=cases,
    )


def _parse_metric(raw: Any, path: str) -> MetricResult:
    value = _object(raw, path)
    _reject_unknown(value, {"metric_key", "score", "passed", "reason"}, path)
    passed_raw = value.get("passed")
    passed = None if passed_raw is None else _scalar_bool(passed_raw, f"{path}.passed")
    reason_raw = value.get("reason")
    reason = (
        None
        if reason_raw is None
        else _bounded_scalar_string(
            reason_raw,
            f"{path}.reason",
            maximum=10000,
            allow_empty=True,
        )
    )
    return MetricResult(
        metric_key=_bounded_string(value, "metric_key", path, maximum=120),
        score=_bounded_number(value, "score", path, minimum=0.0, maximum=1.0),
        passed=passed,
        reason=reason,
    )


def _parse_eval_result(raw: Any, path: str) -> EvalResult:
    value = _object(raw, path)
    _reject_unknown(
        value, {"id", "test_case_id", "output_text", "passed", "metrics", "metadata"}, path
    )
    metrics = tuple(
        _parse_metric(item, f"{path}.metrics[{index}]")
        for index, item in enumerate(_array_field(value, "metrics", path))
    )
    if not metrics:
        raise BundleValidationError(f"{path}.metrics must not be empty")
    _ensure_unique((metric.metric_key for metric in metrics), f"{path}.metrics[].metric_key")
    return EvalResult(
        id=_id(value, "id", path),
        test_case_id=_id(value, "test_case_id", path),
        output_text=_bounded_string(
            value, "output_text", path, maximum=1000000, allow_empty=True
        ),
        passed=_boolean(value, "passed", path),
        metrics=metrics,
        metadata=_optional_object(value, "metadata", path),
    )


def _parse_eval_run(raw: Any, path: str) -> EvalRun:
    value = _object(raw, path)
    _reject_unknown(
        value,
        {
            "id",
            "prompt_version_id",
            "dataset_id",
            "results",
            "model_snapshot",
            "evaluator_snapshot",
        },
        path,
    )
    results = tuple(
        _parse_eval_result(item, f"{path}.results[{index}]")
        for index, item in enumerate(_array_field(value, "results", path))
    )
    if not results:
        raise BundleValidationError(f"{path}.results must not be empty")
    _ensure_unique((item.id for item in results), f"{path}.results[].id")
    _ensure_unique((item.test_case_id for item in results), f"{path}.results[].test_case_id")
    return EvalRun(
        id=_id(value, "id", path),
        prompt_version_id=_id(value, "prompt_version_id", path),
        dataset_id=_id(value, "dataset_id", path),
        results=results,
        model_snapshot=_object_field(value, "model_snapshot", path),
        evaluator_snapshot=_object_field(value, "evaluator_snapshot", path),
    )


def _parse_detection(raw: Any, path: str) -> DetectionConfig:
    value = _object(raw, path)
    _reject_unknown(
        value,
        {
            "primary_metric",
            "metric_drop_threshold",
            "min_target_cases",
            "min_control_cases",
            "support_recovery_ratio",
            "reject_recovery_ratio",
            "max_control_damage",
        },
        path,
    )
    return DetectionConfig(
        primary_metric=_bounded_string(
            value, "primary_metric", path, maximum=120
        ),
        metric_drop_threshold=_bounded_number(
            value,
            "metric_drop_threshold",
            path,
            minimum=0.0,
            maximum=1.0,
        ),
        min_target_cases=_integer(value, "min_target_cases", path, minimum=1),
        min_control_cases=_integer(value, "min_control_cases", path, minimum=1),
        support_recovery_ratio=_bounded_number(
            value,
            "support_recovery_ratio",
            path,
            minimum=0.0,
            maximum=1.0,
        ),
        reject_recovery_ratio=_bounded_number(
            value,
            "reject_recovery_ratio",
            path,
            minimum=0.0,
            maximum=1.0,
        ),
        max_control_damage=_bounded_number(
            value,
            "max_control_damage",
            path,
            minimum=0.0,
            maximum=1.0,
        ),
    )


def _validate_bundle_invariants(bundle: RegressionBundle) -> None:
    if bundle.prompt.project_id != bundle.project.id:
        raise BundleValidationError("prompt.project_id must equal project.id")
    if bundle.dataset.project_id != bundle.project.id:
        raise BundleValidationError("dataset.project_id must equal project.id")
    for label, version in (
        ("baseline_prompt_version", bundle.baseline_prompt_version),
        ("candidate_prompt_version", bundle.candidate_prompt_version),
    ):
        if version.prompt_id != bundle.prompt.id:
            raise BundleValidationError(f"{label}.prompt_id must equal prompt.id")
    if bundle.baseline_prompt_version.id == bundle.candidate_prompt_version.id:
        raise BundleValidationError("baseline and candidate prompt versions must differ")
    if bundle.baseline_eval_run.prompt_version_id != bundle.baseline_prompt_version.id:
        raise BundleValidationError(
            "baseline_eval_run.prompt_version_id must reference baseline_prompt_version.id"
        )
    if bundle.candidate_eval_run.prompt_version_id != bundle.candidate_prompt_version.id:
        raise BundleValidationError(
            "candidate_eval_run.prompt_version_id must reference candidate_prompt_version.id"
        )

    expected_case_ids = {case.id for case in bundle.dataset.test_cases}
    for label, run in (
        ("baseline_eval_run", bundle.baseline_eval_run),
        ("candidate_eval_run", bundle.candidate_eval_run),
    ):
        if not run.model_snapshot:
            raise BundleValidationError(f"{label}.model_snapshot must not be empty")
        if not run.evaluator_snapshot:
            raise BundleValidationError(f"{label}.evaluator_snapshot must not be empty")
        if run.dataset_id != bundle.dataset.id:
            raise BundleValidationError(f"{label}.dataset_id must equal dataset.id")
        actual_case_ids = {result.test_case_id for result in run.results}
        if actual_case_ids != expected_case_ids:
            missing = sorted(expected_case_ids - actual_case_ids)
            extra = sorted(actual_case_ids - expected_case_ids)
            raise BundleValidationError(
                f"{label}.results must cover the dataset exactly; "
                f"missing={missing}, extra={extra}"
            )
        for result in run.results:
            _require_metric(result, bundle.detection.primary_metric, label)

    if bundle.baseline_eval_run.model_snapshot != bundle.candidate_eval_run.model_snapshot:
        raise BundleValidationError(
            "baseline and candidate model_snapshot must match for prompt-only diagnosis"
        )
    if (
        bundle.baseline_eval_run.evaluator_snapshot
        != bundle.candidate_eval_run.evaluator_snapshot
    ):
        raise BundleValidationError(
            "baseline and candidate evaluator_snapshot must match for prompt-only diagnosis"
        )

    if bundle.detection.reject_recovery_ratio > bundle.detection.support_recovery_ratio:
        raise BundleValidationError(
            "detection.reject_recovery_ratio must not exceed support_recovery_ratio"
        )

    known_segment_ids = {
        segment.id for segment in bundle.baseline_prompt_version.segments
    } | {segment.id for segment in bundle.candidate_prompt_version.segments}
    for segment_id, fixture_results in bundle.mock_ablation_results_by_segment.items():
        if segment_id not in known_segment_ids:
            raise BundleValidationError(
                "mock_ablation_results_by_segment contains unknown segment "
                f"{segment_id!r}"
            )
        actual_case_ids = {result.test_case_id for result in fixture_results}
        if actual_case_ids != expected_case_ids:
            missing = sorted(expected_case_ids - actual_case_ids)
            extra = sorted(actual_case_ids - expected_case_ids)
            raise BundleValidationError(
                f"mock ablation fixture {segment_id!r} must cover the dataset exactly; "
                f"missing={missing}, extra={extra}"
            )
        _ensure_unique(
            (result.id for result in fixture_results),
            f"mock_ablation_results_by_segment.{segment_id}[].id",
        )
        _ensure_unique(
            (result.test_case_id for result in fixture_results),
            f"mock_ablation_results_by_segment.{segment_id}[].test_case_id",
        )
        for result in fixture_results:
            _require_metric(result, bundle.detection.primary_metric, "mock ablation")


def _require_metric(result: EvalResult, metric_key: str, label: str) -> None:
    try:
        result.metric(metric_key)
    except KeyError as error:
        raise BundleValidationError(
            f"{label} result for case {result.test_case_id!r} is missing primary "
            f"metric {metric_key!r}"
        ) from error


def _validate_timestamp(value: str, path: str) -> None:
    if not _RFC3339_PATTERN.fullmatch(value):
        raise BundleValidationError(f"{path} must be an RFC 3339 date-time")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise BundleValidationError(f"{path} must be an RFC 3339 date-time") from error
    if parsed.tzinfo is None:
        raise BundleValidationError(f"{path} must include a timezone")


def _ensure_unique(values: Any, path: str) -> None:
    seen: set[Any] = set()
    duplicates: set[Any] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    if duplicates:
        raise BundleValidationError(f"{path} contains duplicates: {sorted(duplicates)!r}")


def _reject_unknown(value: Mapping[str, Any], allowed: set[str], path: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise BundleValidationError(f"{path} contains unknown fields: {unknown!r}")


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def _reject_non_finite_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON number {value!r} is not permitted")


def _validate_json_tree(value: Any, path: str, active: set[int]) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise BundleValidationError(f"{path} contains NaN or infinity")
        return
    if isinstance(value, list):
        identity = id(value)
        if identity in active:
            raise BundleValidationError(f"{path} contains a circular array")
        active.add(identity)
        try:
            for index, item in enumerate(value):
                _validate_json_tree(item, f"{path}[{index}]", active)
        finally:
            active.remove(identity)
        return
    if isinstance(value, dict):
        identity = id(value)
        if identity in active:
            raise BundleValidationError(f"{path} contains a circular object")
        active.add(identity)
        try:
            for key, item in value.items():
                if not isinstance(key, str):
                    raise BundleValidationError(f"{path} object keys must be strings")
                _validate_json_tree(item, f"{path}.{key}", active)
        finally:
            active.remove(identity)
        return
    raise BundleValidationError(
        f"{path} contains non-JSON value of type {type(value).__name__}"
    )


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BundleValidationError(f"{path} must be an object")
    if not all(isinstance(key, str) for key in value):
        raise BundleValidationError(f"{path} object keys must be strings")
    return value


def _array(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise BundleValidationError(f"{path} must be an array")
    return value


def _object_field(value: Mapping[str, Any], key: str, path: str) -> dict[str, Any]:
    if key not in value:
        raise BundleValidationError(f"{path}.{key} is required")
    return _object(value[key], f"{path}.{key}")


def _optional_object(
    value: Mapping[str, Any], key: str, path: str
) -> dict[str, Any]:
    if key not in value:
        return {}
    return _object(value[key], f"{path}.{key}")


def _array_field(value: Mapping[str, Any], key: str, path: str) -> list[Any]:
    if key not in value:
        raise BundleValidationError(f"{path}.{key} is required")
    return _array(value[key], f"{path}.{key}")


def _string(
    value: Mapping[str, Any], key: str, path: str, *, allow_empty: bool = False
) -> str:
    if key not in value:
        raise BundleValidationError(f"{path}.{key} is required")
    return _scalar_string(value[key], f"{path}.{key}", allow_empty=allow_empty)


def _bounded_string(
    value: Mapping[str, Any],
    key: str,
    path: str,
    *,
    maximum: int,
    allow_empty: bool = False,
) -> str:
    if key not in value:
        raise BundleValidationError(f"{path}.{key} is required")
    return _bounded_scalar_string(
        value[key],
        f"{path}.{key}",
        maximum=maximum,
        allow_empty=allow_empty,
    )


def _id(value: Mapping[str, Any], key: str, path: str) -> str:
    if key not in value:
        raise BundleValidationError(f"{path}.{key} is required")
    return _scalar_id(value[key], f"{path}.{key}")


def _scalar_id(value: Any, path: str) -> str:
    parsed = _bounded_scalar_string(value, path, maximum=256)
    if any(character.isspace() for character in parsed):
        raise BundleValidationError(f"{path} must not contain whitespace")
    return parsed


def _scalar_string(value: Any, path: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise BundleValidationError(f"{path} must be a string")
    if not allow_empty and not value.strip():
        raise BundleValidationError(f"{path} must not be empty")
    return value


def _bounded_scalar_string(
    value: Any,
    path: str,
    *,
    maximum: int,
    allow_empty: bool = False,
) -> str:
    parsed = _scalar_string(value, path, allow_empty=allow_empty)
    if len(parsed) > maximum:
        raise BundleValidationError(f"{path} must contain at most {maximum} characters")
    return parsed


def _integer(
    value: Mapping[str, Any], key: str, path: str, *, minimum: int | None = None
) -> int:
    if key not in value:
        raise BundleValidationError(f"{path}.{key} is required")
    parsed = value[key]
    if isinstance(parsed, bool) or not isinstance(parsed, int):
        raise BundleValidationError(f"{path}.{key} must be an integer")
    if minimum is not None and parsed < minimum:
        raise BundleValidationError(f"{path}.{key} must be >= {minimum}")
    return parsed


def _optional_integer(
    value: Mapping[str, Any],
    key: str,
    path: str,
    *,
    default: int,
    minimum: int | None = None,
) -> int:
    if key not in value:
        return default
    return _integer(value, key, path, minimum=minimum)


def _number(value: Mapping[str, Any], key: str, path: str) -> float:
    if key not in value:
        raise BundleValidationError(f"{path}.{key} is required")
    parsed = value[key]
    if isinstance(parsed, bool) or not isinstance(parsed, (int, float)):
        raise BundleValidationError(f"{path}.{key} must be a number")
    try:
        result = float(parsed)
    except OverflowError as error:
        raise BundleValidationError(f"{path}.{key} must be finite") from error
    if not math.isfinite(result):
        raise BundleValidationError(f"{path}.{key} must be finite")
    return result


def _bounded_number(
    value: Mapping[str, Any],
    key: str,
    path: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    result = _number(value, key, path)
    if minimum is not None and result < minimum:
        raise BundleValidationError(f"{path}.{key} must be >= {minimum}")
    if maximum is not None and result > maximum:
        raise BundleValidationError(f"{path}.{key} must be <= {maximum}")
    return result


def _optional_number(
    value: Mapping[str, Any],
    key: str,
    path: str,
    *,
    default: float,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    if key not in value:
        return default
    result = _number(value, key, path)
    if minimum is not None and result < minimum:
        raise BundleValidationError(f"{path}.{key} must be >= {minimum}")
    if maximum is not None and result > maximum:
        raise BundleValidationError(f"{path}.{key} must be <= {maximum}")
    return result


def _boolean(value: Mapping[str, Any], key: str, path: str) -> bool:
    if key not in value:
        raise BundleValidationError(f"{path}.{key} is required")
    return _scalar_bool(value[key], f"{path}.{key}")


def _scalar_bool(value: Any, path: str) -> bool:
    if not isinstance(value, bool):
        raise BundleValidationError(f"{path} must be a boolean")
    return value

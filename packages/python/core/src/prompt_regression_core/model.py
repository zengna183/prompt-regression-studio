"""Vendor-neutral domain objects for prompt regression diagnosis.

The objects are intentionally explicit. Free-form metadata is allowed only where
an integration must preserve source data; the diagnosis chain itself uses typed
fields and stable identifiers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Mapping


JsonObject = Mapping[str, Any]


class PromptChangeType(StrEnum):
    ADDED = "added"
    REMOVED = "removed"
    REWRITTEN = "rewritten"


class RegressionKind(StrEnum):
    HARD = "hard"
    METRIC = "metric"
    HARD_AND_METRIC = "hard_and_metric"


class HypothesisStatus(StrEnum):
    HYPOTHESIZED = "hypothesized"
    SUPPORTED = "supported"
    REJECTED = "rejected"
    INCONCLUSIVE = "inconclusive"


class EvidenceStance(StrEnum):
    SUPPORTING = "supporting"
    CONTRADICTING = "contradicting"
    NEUTRAL = "neutral"


@dataclass(frozen=True, slots=True)
class Project:
    id: str
    name: str


@dataclass(frozen=True, slots=True)
class Prompt:
    id: str
    project_id: str
    name: str


@dataclass(frozen=True, slots=True)
class PromptSegment:
    id: str
    kind: str
    content: str
    ordinal: int
    semantic_tags: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PromptVersion:
    id: str
    prompt_id: str
    version: int
    segments: tuple[PromptSegment, ...]
    content_hash: str


@dataclass(frozen=True, slots=True)
class PromptChange:
    id: str
    segment_id: str
    change_type: PromptChangeType
    old_content: str | None
    new_content: str | None
    old_ordinal: int | None
    new_ordinal: int | None
    semantic_tags: tuple[str, ...]
    semantic_summary: str


@dataclass(frozen=True, slots=True)
class TestCase:
    id: str
    input: JsonObject
    expected: JsonObject | None = None
    metadata: JsonObject = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Dataset:
    id: str
    project_id: str
    name: str
    test_cases: tuple[TestCase, ...]


@dataclass(frozen=True, slots=True)
class MetricResult:
    metric_key: str
    score: float
    passed: bool | None = None
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class EvalResult:
    id: str
    test_case_id: str
    output_text: str
    passed: bool
    metrics: tuple[MetricResult, ...]
    metadata: JsonObject = field(default_factory=dict)

    def metric(self, metric_key: str) -> MetricResult:
        for metric in self.metrics:
            if metric.metric_key == metric_key:
                return metric
        raise KeyError(
            f"EvalResult {self.id!r} has no metric named {metric_key!r}"
        )


@dataclass(frozen=True, slots=True)
class EvalRun:
    id: str
    prompt_version_id: str
    dataset_id: str
    results: tuple[EvalResult, ...]
    model_snapshot: JsonObject
    evaluator_snapshot: JsonObject

    def results_by_case(self) -> dict[str, EvalResult]:
        return {result.test_case_id: result for result in self.results}


@dataclass(frozen=True, slots=True)
class DetectionConfig:
    primary_metric: str
    metric_drop_threshold: float = 0.2
    min_target_cases: int = 2
    min_control_cases: int = 1
    support_recovery_ratio: float = 0.6
    reject_recovery_ratio: float = 0.1
    max_control_damage: float = 0.05


@dataclass(frozen=True, slots=True)
class RegressionCase:
    id: str
    test_case_id: str
    kind: RegressionKind
    baseline_passed: bool
    candidate_passed: bool
    metric_deltas: Mapping[str, float]
    primary_metric: str


@dataclass(frozen=True, slots=True)
class Regression:
    id: str
    baseline_eval_run_id: str
    candidate_eval_run_id: str
    config_hash: str
    cases: tuple[RegressionCase, ...]


@dataclass(frozen=True, slots=True)
class FailureCluster:
    id: str
    key: str
    title: str
    primary_metric: str
    regression_case_ids: tuple[str, ...]
    test_case_ids: tuple[str, ...]
    algorithm: str
    algorithm_version: str


@dataclass(frozen=True, slots=True)
class RootCauseHypothesis:
    id: str
    cluster_id: str
    prompt_change_ids: tuple[str, ...]
    mechanism: str
    expected_if_reverted: str
    prior_confidence: float
    verification_status: HypothesisStatus


@dataclass(frozen=True, slots=True)
class AblationVariant:
    id: str
    hypothesis_id: str
    base_prompt_version_id: str
    strategy: str
    reverted_segment_ids: tuple[str, ...]
    prompt_content_hash: str


@dataclass(frozen=True, slots=True)
class AblationPlan:
    id: str
    hypothesis_id: str
    strategy: str
    variant_ids: tuple[str, ...]
    target_test_case_ids: tuple[str, ...]
    control_test_case_ids: tuple[str, ...]
    config_hash: str


@dataclass(frozen=True, slots=True)
class AblationRun:
    id: str
    plan_id: str
    variant_id: str
    eval_run: EvalRun
    runner: str
    runner_version: str


@dataclass(frozen=True, slots=True)
class Evidence:
    id: str
    hypothesis_id: str
    cluster_id: str
    prompt_change_ids: tuple[str, ...]
    ablation_run_id: str
    metric_key: str
    stance: EvidenceStance
    resulting_status: HypothesisStatus
    target_case_ids: tuple[str, ...]
    control_case_ids: tuple[str, ...]
    target_mean_delta: float
    control_mean_delta: float
    max_observed_control_damage: float
    recovery_ratio: float | None
    target_sample_size: int
    control_sample_size: int
    unrecovered_hard_targets: int
    new_control_failures: int
    rationale: str


@dataclass(frozen=True, slots=True)
class PipelineDescriptor:
    engine: str
    engine_version: str
    config_hash: str


@dataclass(frozen=True, slots=True)
class DiagnosisReport:
    schema_version: str
    report_id: str
    bundle_id: str
    input_bundle_hash: str
    generated_at: str
    pipeline: PipelineDescriptor
    baseline_prompt_version_id: str
    candidate_prompt_version_id: str
    regression: Regression
    prompt_changes: tuple[PromptChange, ...]
    failure_clusters: tuple[FailureCluster, ...]
    hypotheses: tuple[RootCauseHypothesis, ...]
    ablation_plans: tuple[AblationPlan, ...]
    ablation_variants: tuple[AblationVariant, ...]
    ablation_runs: tuple[AblationRun, ...]
    evidence: tuple[Evidence, ...]
    recommendations: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RegressionBundle:
    schema_version: str
    bundle_id: str
    diagnosis_requested_at: str
    project: Project
    prompt: Prompt
    dataset: Dataset
    baseline_prompt_version: PromptVersion
    candidate_prompt_version: PromptVersion
    baseline_eval_run: EvalRun
    candidate_eval_run: EvalRun
    detection: DetectionConfig
    mock_ablation_results_by_segment: Mapping[str, tuple[EvalResult, ...]]

"""Application orchestration for evidence-backed regression diagnosis."""

from __future__ import annotations

from collections import Counter
import math
from typing import Sequence

from .canonical import content_hash, stable_id
from .errors import MissingAblationFixtureError, PipelineInvariantError
from .model import (
    AblationPlan,
    AblationRun,
    AblationVariant,
    DiagnosisReport,
    Evidence,
    FailureCluster,
    HypothesisStatus,
    PipelineDescriptor,
    PromptChange,
    RegressionCase,
    RegressionBundle,
    RootCauseHypothesis,
)
from .ports import (
    AblationRunner,
    AblationStrategy,
    EvidenceScorer,
    FailureClusterer,
    RootCauseStrategy,
    SemanticDiffStrategy,
)
from .strategies import (
    ENGINE_NAME,
    ENGINE_VERSION,
    FixtureAblationRunner,
    MetadataFailureClusterer,
    RuleBasedRootCauseStrategy,
    SingleSegmentRevertStrategy,
    StableSegmentDiff,
    ThresholdEvidenceScorer,
    apply_evidence_status,
    detect_regression,
)


REPORT_SCHEMA_VERSION = "prompt-regression.report/v1alpha1"


class DiagnosisPipeline:
    """Compose replaceable strategies while enforcing cross-stage references."""

    def __init__(
        self,
        *,
        semantic_diff: SemanticDiffStrategy | None = None,
        failure_clusterer: FailureClusterer | None = None,
        root_cause_strategy: RootCauseStrategy | None = None,
        ablation_strategy: AblationStrategy | None = None,
        ablation_runner: AblationRunner | None = None,
        evidence_scorer: EvidenceScorer | None = None,
    ) -> None:
        self._semantic_diff = semantic_diff or StableSegmentDiff()
        self._failure_clusterer = failure_clusterer or MetadataFailureClusterer()
        self._root_cause_strategy = root_cause_strategy or RuleBasedRootCauseStrategy()
        self._ablation_strategy = ablation_strategy or SingleSegmentRevertStrategy()
        self._ablation_runner = ablation_runner or FixtureAblationRunner()
        self._evidence_scorer = evidence_scorer or ThresholdEvidenceScorer()

    def run(self, bundle: RegressionBundle) -> DiagnosisReport:
        """Produce a deterministic diagnosis report for one paired comparison."""

        regression = detect_regression(bundle)
        changes = tuple(
            sorted(
                self._semantic_diff.diff(
                    bundle.baseline_prompt_version, bundle.candidate_prompt_version
                ),
                key=lambda item: item.id,
            )
        )
        clusters = tuple(
            sorted(
                self._failure_clusterer.cluster(regression, bundle),
                key=lambda item: item.id,
            )
        )
        hypotheses = tuple(
            sorted(
                self._root_cause_strategy.propose(clusters, changes, bundle),
                key=lambda item: item.id,
            )
        )
        _validate_strategy_output(changes, clusters, hypotheses, regression.cases)

        cluster_by_id = {cluster.id: cluster for cluster in clusters}
        final_hypotheses: list[RootCauseHypothesis] = []
        plans: list[AblationPlan] = []
        variants: list[AblationVariant] = []
        runs: list[AblationRun] = []
        evidence_items: list[Evidence] = []
        missing_fixtures: list[tuple[RootCauseHypothesis, AblationVariant]] = []

        for hypothesis in hypotheses:
            cluster = cluster_by_id[hypothesis.cluster_id]
            plan, planned_variants = self._ablation_strategy.plan(
                hypothesis, cluster, changes, bundle
            )
            planned_variants = tuple(planned_variants)
            _validate_plan(
                plan,
                planned_variants,
                hypothesis,
                cluster,
                changes,
                regression.cases,
                bundle,
            )
            plans.append(plan)
            variants.extend(planned_variants)

            hypothesis_evidence: list[Evidence] = []
            for variant in planned_variants:
                try:
                    run = self._ablation_runner.run(plan, variant, bundle)
                except MissingAblationFixtureError:
                    missing_fixtures.append((hypothesis, variant))
                    continue
                _validate_run(run, plan, variant, bundle)
                evidence = self._evidence_scorer.score(
                    hypothesis, cluster, plan, run, changes, bundle
                )
                _validate_evidence(evidence, hypothesis, cluster, plan, run)
                runs.append(run)
                evidence_items.append(evidence)
                hypothesis_evidence.append(evidence)

            final_hypotheses.append(
                _merge_hypothesis_evidence(hypothesis, hypothesis_evidence)
            )

        _require_unique_ids(plans, "ablation plans")
        _require_unique_ids(variants, "ablation variants")
        _require_unique_ids(runs, "ablation runs")
        _require_unique_ids(evidence_items, "evidence items")

        pipeline_payload = {
            "engine": ENGINE_NAME,
            "engine_version": ENGINE_VERSION,
            "semantic_diff": _component_descriptor(self._semantic_diff),
            "failure_clusterer": _component_descriptor(self._failure_clusterer),
            "root_cause_strategy": _component_descriptor(self._root_cause_strategy),
            "ablation_strategy": _component_descriptor(self._ablation_strategy),
            "ablation_runner": _component_descriptor(self._ablation_runner),
            "evidence_scorer": _component_descriptor(self._evidence_scorer),
            "detection": bundle.detection,
        }
        pipeline = PipelineDescriptor(
            engine=ENGINE_NAME,
            engine_version=ENGINE_VERSION,
            config_hash=content_hash(pipeline_payload),
        )
        recommendations = _recommendations(
            regression_case_count=len(regression.cases),
            changes=changes,
            hypotheses=tuple(final_hypotheses),
            missing_fixtures=missing_fixtures,
        )
        input_bundle_hash = content_hash(bundle)
        report_payload = {
            "schema_version": REPORT_SCHEMA_VERSION,
            "bundle_id": bundle.bundle_id,
            "input_bundle_hash": input_bundle_hash,
            "generated_at": bundle.diagnosis_requested_at,
            "pipeline": pipeline,
            "baseline_prompt_version_id": bundle.baseline_prompt_version.id,
            "candidate_prompt_version_id": bundle.candidate_prompt_version.id,
            "regression": regression,
            "prompt_changes": changes,
            "failure_clusters": clusters,
            "hypotheses": tuple(sorted(final_hypotheses, key=lambda item: item.id)),
            "ablation_plans": tuple(sorted(plans, key=lambda item: item.id)),
            "ablation_variants": tuple(sorted(variants, key=lambda item: item.id)),
            "ablation_runs": tuple(sorted(runs, key=lambda item: item.id)),
            "evidence": tuple(sorted(evidence_items, key=lambda item: item.id)),
            "recommendations": recommendations,
        }
        return DiagnosisReport(
            schema_version=REPORT_SCHEMA_VERSION,
            report_id=stable_id("report", report_payload),
            bundle_id=bundle.bundle_id,
            input_bundle_hash=input_bundle_hash,
            generated_at=bundle.diagnosis_requested_at,
            pipeline=pipeline,
            baseline_prompt_version_id=bundle.baseline_prompt_version.id,
            candidate_prompt_version_id=bundle.candidate_prompt_version.id,
            regression=regression,
            prompt_changes=changes,
            failure_clusters=clusters,
            hypotheses=tuple(sorted(final_hypotheses, key=lambda item: item.id)),
            ablation_plans=tuple(sorted(plans, key=lambda item: item.id)),
            ablation_variants=tuple(sorted(variants, key=lambda item: item.id)),
            ablation_runs=tuple(sorted(runs, key=lambda item: item.id)),
            evidence=tuple(sorted(evidence_items, key=lambda item: item.id)),
            recommendations=recommendations,
        )


def _component_descriptor(component: object) -> dict[str, object]:
    name = getattr(component, "name", component.__class__.__name__)
    version = getattr(component, "version", "unknown")
    descriptor: dict[str, object] = {
        "name": str(name),
        "version": str(version),
    }
    configuration = getattr(component, "configuration", None)
    if callable(configuration):
        configuration = configuration()
    if configuration is not None:
        descriptor["configuration"] = configuration
    return descriptor


def _validate_strategy_output(
    changes: Sequence[PromptChange],
    clusters: Sequence[FailureCluster],
    hypotheses: Sequence[RootCauseHypothesis],
    regression_cases: Sequence[object],
) -> None:
    _require_unique_ids(changes, "prompt changes")
    _require_unique_ids(clusters, "failure clusters")
    _require_unique_ids(hypotheses, "root-cause hypotheses")
    regression_by_id = {
        getattr(item, "id"): item
        for item in regression_cases
        if isinstance(item, RegressionCase)
    }
    if len(regression_by_id) != len(regression_cases):
        raise PipelineInvariantError("Regression cases must be typed and uniquely identified")
    known_regression_ids = set(regression_by_id)
    known_change_ids = {item.id for item in changes}
    known_cluster_ids = {item.id for item in clusters}
    assigned_regression_ids: list[str] = []
    for cluster in clusters:
        _require_unique_string_values(
            cluster.regression_case_ids,
            f"cluster {cluster.id} regression_case_ids",
            allow_empty=False,
        )
        _require_unique_string_values(
            cluster.test_case_ids,
            f"cluster {cluster.id} test_case_ids",
            allow_empty=False,
        )
        referenced_regression_ids = set(cluster.regression_case_ids)
        if not referenced_regression_ids <= known_regression_ids:
            raise PipelineInvariantError(
                f"Cluster {cluster.id} references unknown regression cases"
            )
        expected_test_case_ids = {
            regression_by_id[item_id].test_case_id
            for item_id in referenced_regression_ids
        }
        if set(cluster.test_case_ids) != expected_test_case_ids:
            raise PipelineInvariantError(
                f"Cluster {cluster.id} test cases do not match its regression cases"
            )
        if any(
            regression_by_id[item_id].primary_metric != cluster.primary_metric
            for item_id in referenced_regression_ids
        ):
            raise PipelineInvariantError(
                f"Cluster {cluster.id} primary metric does not match its regression cases"
            )
        assigned_regression_ids.extend(cluster.regression_case_ids)
    assignment_counts = Counter(assigned_regression_ids)
    if set(assignment_counts) != known_regression_ids or any(
        count != 1 for count in assignment_counts.values()
    ):
        raise PipelineInvariantError(
            "Failure clusters must partition all regression cases exactly once"
        )
    for hypothesis in hypotheses:
        if hypothesis.cluster_id not in known_cluster_ids:
            raise PipelineInvariantError(
                f"Hypothesis {hypothesis.id} references unknown cluster"
            )
        if not hypothesis.prompt_change_ids:
            raise PipelineInvariantError(
                f"Hypothesis {hypothesis.id} must reference at least one prompt change"
            )
        if not set(hypothesis.prompt_change_ids) <= known_change_ids:
            raise PipelineInvariantError(
                f"Hypothesis {hypothesis.id} references unknown prompt changes"
            )
        _require_unique_string_values(
            hypothesis.prompt_change_ids,
            f"hypothesis {hypothesis.id} prompt_change_ids",
            allow_empty=False,
        )
        if not math.isfinite(hypothesis.prior_confidence) or not (
            0.0 <= hypothesis.prior_confidence <= 1.0
        ):
            raise PipelineInvariantError(
                f"Hypothesis {hypothesis.id} prior_confidence must be between 0 and 1"
            )
        if hypothesis.verification_status is not HypothesisStatus.HYPOTHESIZED:
            raise PipelineInvariantError(
                "A root-cause strategy may only propose hypothesized hypotheses"
            )


def _validate_plan(
    plan: AblationPlan,
    variants: Sequence[AblationVariant],
    hypothesis: RootCauseHypothesis,
    cluster: FailureCluster,
    changes: Sequence[PromptChange],
    regression_cases: Sequence[RegressionCase],
    bundle: RegressionBundle,
) -> None:
    if plan.hypothesis_id != hypothesis.id:
        raise PipelineInvariantError("Ablation plan references a different hypothesis")
    if not variants:
        raise PipelineInvariantError("Ablation plan must include at least one variant")
    _require_unique_ids(variants, "ablation variants")
    if tuple(item.id for item in variants) != plan.variant_ids:
        raise PipelineInvariantError("Ablation plan variant_ids do not match variants")
    _require_unique_string_values(
        plan.target_test_case_ids,
        f"plan {plan.id} target_test_case_ids",
        allow_empty=False,
    )
    _require_unique_string_values(
        plan.control_test_case_ids,
        f"plan {plan.id} control_test_case_ids",
        allow_empty=True,
    )
    if set(plan.target_test_case_ids) != set(cluster.test_case_ids):
        raise PipelineInvariantError("Ablation target cases must match the failure cluster")
    if set(plan.target_test_case_ids) & set(plan.control_test_case_ids):
        raise PipelineInvariantError("Ablation target and control cases must be disjoint")
    dataset_case_ids = {item.id for item in bundle.dataset.test_cases}
    if not set(plan.target_test_case_ids) <= dataset_case_ids:
        raise PipelineInvariantError("Ablation plan references unknown target cases")
    expected_control_ids = dataset_case_ids - {
        item.test_case_id for item in regression_cases
    }
    if set(plan.control_test_case_ids) != expected_control_ids:
        raise PipelineInvariantError(
            "Ablation controls must include every non-regression dataset case"
        )
    change_by_id = {item.id: item for item in changes}
    hypothesis_segment_ids = {
        change_by_id[item_id].segment_id for item_id in hypothesis.prompt_change_ids
    }
    for variant in variants:
        if variant.hypothesis_id != hypothesis.id:
            raise PipelineInvariantError("Ablation variant references a different hypothesis")
        if variant.base_prompt_version_id != bundle.candidate_prompt_version.id:
            raise PipelineInvariantError(
                "Ablation variant must use the candidate prompt as its base"
            )
        _require_unique_string_values(
            variant.reverted_segment_ids,
            f"variant {variant.id} reverted_segment_ids",
            allow_empty=False,
        )
        if not set(variant.reverted_segment_ids) <= hypothesis_segment_ids:
            raise PipelineInvariantError(
                "Ablation variant reverts a segment outside its hypothesis"
            )
        expected_hash = _reverted_prompt_hash(
            bundle, variant.reverted_segment_ids
        )
        if variant.prompt_content_hash != expected_hash:
            raise PipelineInvariantError(
                "Ablation variant prompt_content_hash does not match the declared reverts"
            )


def _validate_run(
    run: AblationRun,
    plan: AblationPlan,
    variant: AblationVariant,
    bundle: RegressionBundle,
) -> None:
    if run.plan_id != plan.id or run.variant_id != variant.id:
        raise PipelineInvariantError("Ablation run references the wrong plan or variant")
    if run.eval_run.prompt_version_id != variant.id:
        raise PipelineInvariantError(
            "Ablation eval run must reference the executed variant"
        )
    if run.eval_run.dataset_id != bundle.dataset.id:
        raise PipelineInvariantError("Ablation run evaluated a different dataset")
    if run.eval_run.model_snapshot != bundle.candidate_eval_run.model_snapshot:
        raise PipelineInvariantError(
            "Ablation model_snapshot differs from the locked comparison snapshot"
        )
    if run.eval_run.evaluator_snapshot != bundle.candidate_eval_run.evaluator_snapshot:
        raise PipelineInvariantError(
            "Ablation evaluator_snapshot differs from the locked comparison snapshot"
        )
    _require_unique_ids(run.eval_run.results, "ablation evaluation results")
    actual_case_ids = [item.test_case_id for item in run.eval_run.results]
    _require_unique_string_values(
        actual_case_ids,
        "ablation evaluation result test_case_ids",
        allow_empty=False,
    )
    actual_ids = set(actual_case_ids)
    expected_ids = {item.id for item in bundle.dataset.test_cases}
    if actual_ids != expected_ids:
        raise PipelineInvariantError(
            "Ablation run must cover the same dataset as baseline and candidate"
        )
    for result in run.eval_run.results:
        metric_keys = [item.metric_key for item in result.metrics]
        _require_unique_string_values(
            metric_keys,
            f"ablation result {result.id} metric keys",
            allow_empty=False,
        )
        if bundle.detection.primary_metric not in metric_keys:
            raise PipelineInvariantError(
                f"Ablation result {result.id} is missing the primary metric"
            )
        if any(
            not math.isfinite(item.score) or not 0.0 <= item.score <= 1.0
            for item in result.metrics
        ):
            raise PipelineInvariantError(
                f"Ablation result {result.id} contains a metric outside [0, 1]"
            )


def _validate_evidence(
    evidence: Evidence,
    hypothesis: RootCauseHypothesis,
    cluster: FailureCluster,
    plan: AblationPlan,
    run: AblationRun,
) -> None:
    if evidence.hypothesis_id != hypothesis.id:
        raise PipelineInvariantError("Evidence references the wrong hypothesis")
    if evidence.cluster_id != cluster.id:
        raise PipelineInvariantError("Evidence references the wrong failure cluster")
    if evidence.ablation_run_id != run.id:
        raise PipelineInvariantError("Evidence references the wrong ablation run")
    if set(evidence.prompt_change_ids) != set(hypothesis.prompt_change_ids):
        raise PipelineInvariantError(
            "Evidence prompt changes do not match the hypothesis"
        )
    _require_unique_string_values(
        evidence.prompt_change_ids,
        f"evidence {evidence.id} prompt_change_ids",
        allow_empty=False,
    )
    if evidence.metric_key != cluster.primary_metric:
        raise PipelineInvariantError("Evidence scored a different primary metric")
    _require_unique_string_values(
        evidence.target_case_ids,
        f"evidence {evidence.id} target_case_ids",
        allow_empty=False,
    )
    _require_unique_string_values(
        evidence.control_case_ids,
        f"evidence {evidence.id} control_case_ids",
        allow_empty=True,
    )
    if set(evidence.target_case_ids) != set(plan.target_test_case_ids):
        raise PipelineInvariantError("Evidence target cases do not match the plan")
    if set(evidence.control_case_ids) != set(plan.control_test_case_ids):
        raise PipelineInvariantError("Evidence control cases do not match the plan")
    if evidence.target_sample_size != len(evidence.target_case_ids):
        raise PipelineInvariantError("Evidence target sample size is inconsistent")
    if evidence.control_sample_size != len(evidence.control_case_ids):
        raise PipelineInvariantError("Evidence control sample size is inconsistent")
    if evidence.resulting_status is HypothesisStatus.HYPOTHESIZED:
        raise PipelineInvariantError(
            "Executed evidence cannot leave a hypothesis in hypothesized status"
        )
    numeric_values = (
        evidence.target_mean_delta,
        evidence.control_mean_delta,
        evidence.max_observed_control_damage,
    )
    if any(not math.isfinite(value) for value in numeric_values):
        raise PipelineInvariantError("Evidence contains a non-finite delta")
    if evidence.recovery_ratio is not None and not math.isfinite(
        evidence.recovery_ratio
    ):
        raise PipelineInvariantError("Evidence contains a non-finite recovery ratio")
    if evidence.max_observed_control_damage < 0.0:
        raise PipelineInvariantError(
            "Evidence max_observed_control_damage must not be negative"
        )
    for label, value, sample_size in (
        (
            "unrecovered_hard_targets",
            evidence.unrecovered_hard_targets,
            evidence.target_sample_size,
        ),
        (
            "new_control_failures",
            evidence.new_control_failures,
            evidence.control_sample_size,
        ),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or not (
            0 <= value <= sample_size
        ):
            raise PipelineInvariantError(
                f"Evidence {label} must be between zero and its sample size"
            )


def _merge_hypothesis_evidence(
    hypothesis: RootCauseHypothesis, evidence: Sequence[Evidence]
) -> RootCauseHypothesis:
    if not evidence:
        return hypothesis
    statuses = {item.resulting_status for item in evidence}
    if HypothesisStatus.SUPPORTED in statuses and HypothesisStatus.REJECTED in statuses:
        return apply_evidence_status(
            hypothesis,
            next(
                item
                for item in evidence
                if item.resulting_status is HypothesisStatus.INCONCLUSIVE
            )
            if HypothesisStatus.INCONCLUSIVE in statuses
            else _as_inconclusive(evidence[0]),
        )
    if HypothesisStatus.SUPPORTED in statuses:
        selected = next(
            item
            for item in evidence
            if item.resulting_status is HypothesisStatus.SUPPORTED
        )
    elif HypothesisStatus.REJECTED in statuses:
        selected = next(
            item
            for item in evidence
            if item.resulting_status is HypothesisStatus.REJECTED
        )
    else:
        selected = evidence[0]
    return apply_evidence_status(hypothesis, selected)


def _as_inconclusive(evidence: Evidence) -> Evidence:
    from dataclasses import replace

    return replace(evidence, resulting_status=HypothesisStatus.INCONCLUSIVE)


def _reverted_prompt_hash(
    bundle: RegressionBundle, reverted_segment_ids: Sequence[str]
) -> str:
    """Reconstruct the declared intervention and reject ambiguous ordering."""

    baseline_by_id = {
        item.id: item for item in bundle.baseline_prompt_version.segments
    }
    segments_by_id = {
        item.id: item for item in bundle.candidate_prompt_version.segments
    }
    for segment_id in reverted_segment_ids:
        if segment_id in baseline_by_id:
            segments_by_id[segment_id] = baseline_by_id[segment_id]
        elif segment_id in segments_by_id:
            del segments_by_id[segment_id]
        else:
            raise PipelineInvariantError(
                f"Ablation references unknown segment {segment_id!r}"
            )
    ordered = tuple(
        sorted(segments_by_id.values(), key=lambda item: (item.ordinal, item.id))
    )
    ordinals = [item.ordinal for item in ordered]
    if len(ordinals) != len(set(ordinals)):
        raise PipelineInvariantError(
            "A single-segment intervention creates ambiguous prompt ordering; "
            "plan a joint ordering ablation instead"
        )
    return content_hash(
        [
            {
                "id": item.id,
                "kind": item.kind,
                "content": item.content,
                "ordinal": item.ordinal,
                "semantic_tags": list(item.semantic_tags),
            }
            for item in ordered
        ]
    )


def _require_unique_ids(values: Sequence[object], label: str) -> None:
    ids = [getattr(item, "id", None) for item in values]
    if any(not isinstance(item_id, str) or not item_id for item_id in ids):
        raise PipelineInvariantError(f"All {label} must have non-empty string ids")
    if len(ids) != len(set(ids)):
        raise PipelineInvariantError(f"Duplicate ids returned for {label}")


def _require_unique_string_values(
    values: Sequence[str], label: str, *, allow_empty: bool
) -> None:
    if not allow_empty and not values:
        raise PipelineInvariantError(f"{label} must not be empty")
    if any(not isinstance(value, str) or not value for value in values):
        raise PipelineInvariantError(f"{label} must contain non-empty strings")
    if len(values) != len(set(values)):
        raise PipelineInvariantError(f"{label} contains duplicates")


def _recommendations(
    *,
    regression_case_count: int,
    changes: Sequence[PromptChange],
    hypotheses: Sequence[RootCauseHypothesis],
    missing_fixtures: Sequence[tuple[RootCauseHypothesis, AblationVariant]],
) -> tuple[str, ...]:
    if regression_case_count == 0:
        return (
            "No regression crossed the declared gates; keep the paired results "
            "as a baseline artifact.",
        )
    recommendations: list[str] = []
    if not changes:
        recommendations.append(
            "A regression exists without a prompt change; inspect model, evaluator, "
            "dataset, and runtime snapshots."
        )
    for hypothesis in hypotheses:
        change_ids = ", ".join(hypothesis.prompt_change_ids)
        if hypothesis.verification_status is HypothesisStatus.SUPPORTED:
            recommendations.append(
                f"Controlled ablation supports hypothesis {hypothesis.id} for changes "
                f"{change_ids}; create a candidate fix, then re-run the full dataset."
            )
        elif hypothesis.verification_status is HypothesisStatus.REJECTED:
            recommendations.append(
                f"Controlled ablation contradicts hypothesis {hypothesis.id}; do not label "
                f"changes {change_ids} as the root cause."
            )
        elif hypothesis.verification_status is HypothesisStatus.INCONCLUSIVE:
            recommendations.append(
                f"Evidence for hypothesis {hypothesis.id} is inconclusive; increase target "
                "coverage or reduce confounding changes before deciding."
            )
    for hypothesis, variant in missing_fixtures:
        recommendations.append(
            f"Hypothesis {hypothesis.id} remains unverified because variant {variant.id} "
            "has no explicit ablation results."
        )
    if not hypotheses and changes:
        recommendations.append(
            "Regression and prompt changes were found, but no strategy produced a "
            "testable hypothesis."
        )
    return tuple(dict.fromkeys(recommendations))

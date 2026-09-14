"""Deterministic reference strategies for the first vertical slice.

These strategies are intentionally modest: they provide reproducible baselines and
never claim that text similarity proves causality. A hypothesis becomes supported
only after the fixture-backed controlled ablation meets explicit thresholds.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
import re
from statistics import fmean
from typing import Mapping, Sequence

from .canonical import content_hash, stable_id
from .errors import MissingAblationFixtureError, PipelineInvariantError
from .model import (
    AblationPlan,
    AblationRun,
    AblationVariant,
    EvalRun,
    Evidence,
    EvidenceStance,
    FailureCluster,
    HypothesisStatus,
    PromptChange,
    PromptChangeType,
    PromptSegment,
    PromptVersion,
    Regression,
    RegressionBundle,
    RegressionCase,
    RegressionKind,
    RootCauseHypothesis,
)


ENGINE_NAME = "prompt-regression-reference"
ENGINE_VERSION = "0.1.0a1"


def detect_regression(bundle: RegressionBundle) -> Regression:
    """Detect paired hard failures and primary-metric drops."""

    baseline_by_case = bundle.baseline_eval_run.results_by_case()
    candidate_by_case = bundle.candidate_eval_run.results_by_case()
    config = bundle.detection
    cases: list[RegressionCase] = []

    for test_case in sorted(bundle.dataset.test_cases, key=lambda item: item.id):
        baseline = baseline_by_case[test_case.id]
        candidate = candidate_by_case[test_case.id]
        baseline_metrics = {item.metric_key: item.score for item in baseline.metrics}
        candidate_metrics = {item.metric_key: item.score for item in candidate.metrics}
        shared_metrics = sorted(baseline_metrics.keys() & candidate_metrics.keys())
        metric_deltas = {
            key: round(candidate_metrics[key] - baseline_metrics[key], 12)
            for key in shared_metrics
        }
        hard = baseline.passed and not candidate.passed
        primary_delta = metric_deltas[config.primary_metric]
        metric = primary_delta <= -config.metric_drop_threshold
        if not hard and not metric:
            continue
        kind = (
            RegressionKind.HARD_AND_METRIC
            if hard and metric
            else RegressionKind.HARD
            if hard
            else RegressionKind.METRIC
        )
        case_id = stable_id(
            "regcase",
            {
                "baseline_run": bundle.baseline_eval_run.id,
                "candidate_run": bundle.candidate_eval_run.id,
                "test_case": test_case.id,
                "kind": kind.value,
                "metric_deltas": metric_deltas,
            },
        )
        cases.append(
            RegressionCase(
                id=case_id,
                test_case_id=test_case.id,
                kind=kind,
                baseline_passed=baseline.passed,
                candidate_passed=candidate.passed,
                metric_deltas=metric_deltas,
                primary_metric=config.primary_metric,
            )
        )

    config_hash = content_hash(config)
    return Regression(
        id=stable_id(
            "regression",
            {
                "baseline_run": bundle.baseline_eval_run.id,
                "candidate_run": bundle.candidate_eval_run.id,
                "config_hash": config_hash,
                "case_ids": [item.id for item in cases],
            },
        ),
        baseline_eval_run_id=bundle.baseline_eval_run.id,
        candidate_eval_run_id=bundle.candidate_eval_run.id,
        config_hash=config_hash,
        cases=tuple(cases),
    )


class StableSegmentDiff:
    """Compare prompt segments by stable segment id."""

    name = "stable-segment-diff"
    version = "1.0.0"

    def diff(
        self, baseline: PromptVersion, candidate: PromptVersion
    ) -> Sequence[PromptChange]:
        baseline_by_id = {segment.id: segment for segment in baseline.segments}
        candidate_by_id = {segment.id: segment for segment in candidate.segments}
        changes: list[PromptChange] = []
        ordered_ids = sorted(
            baseline_by_id.keys() | candidate_by_id.keys(),
            key=lambda segment_id: (
                (
                    candidate_by_id[segment_id]
                    if segment_id in candidate_by_id
                    else baseline_by_id[segment_id]
                ).ordinal,
                segment_id,
            ),
        )

        for segment_id in ordered_ids:
            old = baseline_by_id.get(segment_id)
            new = candidate_by_id.get(segment_id)
            if old is not None and new is not None:
                if (
                    old.content == new.content
                    and old.kind == new.kind
                    and old.ordinal == new.ordinal
                    and old.semantic_tags == new.semantic_tags
                ):
                    continue
                change_type = PromptChangeType.REWRITTEN
            elif old is None:
                change_type = PromptChangeType.ADDED
            else:
                change_type = PromptChangeType.REMOVED

            tags = tuple(
                sorted(
                    set(old.semantic_tags if old else ())
                    | set(new.semantic_tags if new else ())
                )
            )
            descriptor = {
                "baseline_prompt": baseline.id,
                "candidate_prompt": candidate.id,
                "segment_id": segment_id,
                "change_type": change_type.value,
                "old": old.content if old else None,
                "new": new.content if new else None,
                "old_ordinal": old.ordinal if old else None,
                "new_ordinal": new.ordinal if new else None,
                "semantic_tags": tags,
            }
            changes.append(
                PromptChange(
                    id=stable_id("change", descriptor),
                    segment_id=segment_id,
                    change_type=change_type,
                    old_content=old.content if old else None,
                    new_content=new.content if new else None,
                    old_ordinal=old.ordinal if old else None,
                    new_ordinal=new.ordinal if new else None,
                    semantic_tags=tags,
                    semantic_summary=_change_summary(change_type, segment_id, old, new),
                )
            )
        return changes


def _change_summary(
    change_type: PromptChangeType,
    segment_id: str,
    old: PromptSegment | None,
    new: PromptSegment | None,
) -> str:
    if change_type is PromptChangeType.ADDED:
        return f"Segment {segment_id!r} was added ({len(new.content) if new else 0} chars)."
    if change_type is PromptChangeType.REMOVED:
        return f"Segment {segment_id!r} was removed ({len(old.content) if old else 0} chars)."
    old_size = len(old.content) if old else 0
    new_size = len(new.content) if new else 0
    moved = old is not None and new is not None and old.ordinal != new.ordinal
    suffix = " and moved" if moved else ""
    return (
        f"Segment {segment_id!r} was rewritten from {old_size} to {new_size} "
        f"chars{suffix}."
    )


class MetadataFailureClusterer:
    """Group regressions by an explicit imported failure mode when available."""

    name = "metadata-or-primary-metric"
    version = "1.0.0"

    def cluster(
        self, regression: Regression, bundle: RegressionBundle
    ) -> Sequence[FailureCluster]:
        candidate_by_case = bundle.candidate_eval_run.results_by_case()
        grouped: dict[str, list[RegressionCase]] = defaultdict(list)
        for item in regression.cases:
            raw_mode = candidate_by_case[item.test_case_id].metadata.get("failure_mode")
            key = (
                str(raw_mode).strip()
                if isinstance(raw_mode, str) and raw_mode.strip()
                else f"metric:{item.primary_metric}"
            )
            grouped[key].append(item)

        clusters: list[FailureCluster] = []
        for key in sorted(grouped):
            cases = sorted(grouped[key], key=lambda item: item.test_case_id)
            descriptor = {
                "regression_id": regression.id,
                "key": key,
                "regression_case_ids": [item.id for item in cases],
                "algorithm": self.name,
                "algorithm_version": self.version,
            }
            clusters.append(
                FailureCluster(
                    id=stable_id("cluster", descriptor),
                    key=key,
                    title=f"Failure mode: {key}",
                    primary_metric=bundle.detection.primary_metric,
                    regression_case_ids=tuple(item.id for item in cases),
                    test_case_ids=tuple(item.test_case_id for item in cases),
                    algorithm=self.name,
                    algorithm_version=self.version,
                )
            )
        return clusters


class RuleBasedRootCauseStrategy:
    """Rank changed segments as hypotheses; it does not assert a root cause."""

    name = "tag-overlap-hypothesis"
    version = "1.0.0"

    def __init__(self, *, max_hypotheses_per_cluster: int = 3) -> None:
        if max_hypotheses_per_cluster < 1:
            raise ValueError("max_hypotheses_per_cluster must be >= 1")
        self._limit = max_hypotheses_per_cluster

    @property
    def configuration(self) -> Mapping[str, object]:
        """Public, hashable settings used in the pipeline provenance record."""

        return {"max_hypotheses_per_cluster": self._limit}

    def propose(
        self,
        clusters: Sequence[FailureCluster],
        changes: Sequence[PromptChange],
        bundle: RegressionBundle,
    ) -> Sequence[RootCauseHypothesis]:
        del bundle
        hypotheses: list[RootCauseHypothesis] = []
        for cluster in clusters:
            cluster_tokens = _tokens(f"{cluster.key} {cluster.title}")
            ranked: list[tuple[float, PromptChange]] = []
            for change in changes:
                change_tokens = _tokens(
                    " ".join(
                        (
                            change.segment_id,
                            *change.semantic_tags,
                            change.old_content or "",
                            change.new_content or "",
                        )
                    )
                )
                overlap = len(cluster_tokens & change_tokens) / max(1, len(cluster_tokens))
                ranked.append((overlap, change))
            ranked.sort(key=lambda item: (-item[0], item[1].id))

            for rank, (overlap, change) in enumerate(ranked[: self._limit], start=1):
                prior = round(min(0.75, 0.30 + 0.30 * overlap + 0.05 / rank), 4)
                descriptor = {
                    "cluster_id": cluster.id,
                    "prompt_change_id": change.id,
                    "strategy": self.name,
                    "strategy_version": self.version,
                }
                hypotheses.append(
                    RootCauseHypothesis(
                        id=stable_id("hypothesis", descriptor),
                        cluster_id=cluster.id,
                        prompt_change_ids=(change.id,),
                        mechanism=(
                            f"The change to segment {change.segment_id!r} may have "
                            f"contributed to cluster {cluster.key!r}. This is a ranked "
                            "hypothesis, not a causal conclusion."
                        ),
                        expected_if_reverted=(
                            f"Reverting only segment {change.segment_id!r} should improve "
                            f"{cluster.primary_metric!r} on target cases without materially "
                            "harming control cases."
                        ),
                        prior_confidence=prior,
                        verification_status=HypothesisStatus.HYPOTHESIZED,
                    )
                )
        return hypotheses


class SingleSegmentRevertStrategy:
    """Create one controlled variant that reverts one changed segment."""

    name = "single-segment-revert"
    version = "1.0.0"

    def plan(
        self,
        hypothesis: RootCauseHypothesis,
        cluster: FailureCluster,
        changes: Sequence[PromptChange],
        bundle: RegressionBundle,
    ) -> tuple[AblationPlan, Sequence[AblationVariant]]:
        change_by_id = {change.id: change for change in changes}
        if len(hypothesis.prompt_change_ids) != 1:
            raise PipelineInvariantError(
                "single-segment-revert requires exactly one prompt change"
            )
        change = change_by_id[hypothesis.prompt_change_ids[0]]
        reverted_segments = _revert_segment(
            bundle.baseline_prompt_version,
            bundle.candidate_prompt_version,
            change.segment_id,
        )
        variant_descriptor = {
            "hypothesis_id": hypothesis.id,
            "base_prompt_version_id": bundle.candidate_prompt_version.id,
            "strategy": self.name,
            "reverted_segment_ids": [change.segment_id],
            "segments": [_segment_payload(item) for item in reverted_segments],
        }
        variant = AblationVariant(
            id=stable_id("variant", variant_descriptor),
            hypothesis_id=hypothesis.id,
            base_prompt_version_id=bundle.candidate_prompt_version.id,
            strategy=self.name,
            reverted_segment_ids=(change.segment_id,),
            prompt_content_hash=content_hash(
                [_segment_payload(item) for item in reverted_segments]
            ),
        )

        all_regression_case_ids = {
            item.test_case_id for item in detect_regression(bundle).cases
        }
        control_ids = tuple(
            sorted(
                case.id
                for case in bundle.dataset.test_cases
                if case.id not in all_regression_case_ids
            )
        )
        target_ids = tuple(sorted(cluster.test_case_ids))
        plan_descriptor = {
            "hypothesis_id": hypothesis.id,
            "strategy": self.name,
            "variant_ids": [variant.id],
            "target_test_case_ids": target_ids,
            "control_test_case_ids": control_ids,
            "detection": bundle.detection,
        }
        plan = AblationPlan(
            id=stable_id("plan", plan_descriptor),
            hypothesis_id=hypothesis.id,
            strategy=self.name,
            variant_ids=(variant.id,),
            target_test_case_ids=target_ids,
            control_test_case_ids=control_ids,
            config_hash=content_hash(plan_descriptor),
        )
        return plan, (variant,)


def _revert_segment(
    baseline: PromptVersion, candidate: PromptVersion, segment_id: str
) -> tuple[PromptSegment, ...]:
    baseline_by_id = {item.id: item for item in baseline.segments}
    result = {item.id: item for item in candidate.segments}
    if segment_id in baseline_by_id:
        result[segment_id] = baseline_by_id[segment_id]
    else:
        result.pop(segment_id, None)
    return tuple(sorted(result.values(), key=lambda item: (item.ordinal, item.id)))


def _segment_payload(segment: PromptSegment) -> Mapping[str, object]:
    return {
        "id": segment.id,
        "kind": segment.kind,
        "content": segment.content,
        "ordinal": segment.ordinal,
        "semantic_tags": list(segment.semantic_tags),
    }


class FixtureAblationRunner:
    """Run an ablation from explicit fixture results; never calls or imitates an LLM."""

    name = "explicit-fixture-runner"
    version = "1.0.0"

    def run(
        self,
        plan: AblationPlan,
        variant: AblationVariant,
        bundle: RegressionBundle,
    ) -> AblationRun:
        if len(variant.reverted_segment_ids) != 1:
            raise PipelineInvariantError(
                "fixture runner requires exactly one reverted segment"
            )
        segment_id = variant.reverted_segment_ids[0]
        fixture = bundle.mock_ablation_results_by_segment.get(segment_id)
        if fixture is None:
            raise MissingAblationFixtureError(
                f"No explicit ablation fixture exists for segment {segment_id!r}"
            )
        eval_run = EvalRun(
            id=stable_id(
                "evalrun",
                {
                    "bundle_id": bundle.bundle_id,
                    "variant_id": variant.id,
                    "fixture_result_ids": [item.id for item in fixture],
                },
            ),
            prompt_version_id=variant.id,
            dataset_id=bundle.dataset.id,
            results=tuple(sorted(fixture, key=lambda item: item.test_case_id)),
            # The fixture contract asserts that these counterfactual results were
            # produced under the same locked conditions. Runner provenance lives on
            # AblationRun; it must never be substituted for model/evaluator identity.
            model_snapshot=bundle.candidate_eval_run.model_snapshot,
            evaluator_snapshot=bundle.candidate_eval_run.evaluator_snapshot,
        )
        run_id = stable_id(
            "ablationrun",
            {"plan_id": plan.id, "variant_id": variant.id, "eval_run_id": eval_run.id},
        )
        return AblationRun(
            id=run_id,
            plan_id=plan.id,
            variant_id=variant.id,
            eval_run=eval_run,
            runner=self.name,
            runner_version=self.version,
        )


class ThresholdEvidenceScorer:
    """Evaluate paired target recovery and control damage against declared gates."""

    name = "paired-recovery-thresholds"
    version = "1.0.0"

    def score(
        self,
        hypothesis: RootCauseHypothesis,
        cluster: FailureCluster,
        plan: AblationPlan,
        run: AblationRun,
        changes: Sequence[PromptChange],
        bundle: RegressionBundle,
    ) -> Evidence:
        del changes
        baseline = bundle.baseline_eval_run.results_by_case()
        candidate = bundle.candidate_eval_run.results_by_case()
        ablation = run.eval_run.results_by_case()
        metric_key = cluster.primary_metric

        target_deltas = [
            ablation[case_id].metric(metric_key).score
            - candidate[case_id].metric(metric_key).score
            for case_id in plan.target_test_case_ids
        ]
        control_deltas = [
            ablation[case_id].metric(metric_key).score
            - candidate[case_id].metric(metric_key).score
            for case_id in plan.control_test_case_ids
        ]
        recoverable = [
            baseline[case_id].metric(metric_key).score
            - candidate[case_id].metric(metric_key).score
            for case_id in plan.target_test_case_ids
        ]
        target_mean_delta = fmean(target_deltas) if target_deltas else 0.0
        control_mean_delta = fmean(control_deltas) if control_deltas else 0.0
        max_observed_control_damage = max(
            (max(0.0, -delta) for delta in control_deltas),
            default=0.0,
        )
        unrecovered_hard_targets = sum(
            1
            for case_id in plan.target_test_case_ids
            if baseline[case_id].passed
            and not candidate[case_id].passed
            and not ablation[case_id].passed
        )
        new_control_failures = sum(
            1
            for case_id in plan.control_test_case_ids
            if candidate[case_id].passed and not ablation[case_id].passed
        )
        recoverable_mean = fmean(recoverable) if recoverable else 0.0
        recovery_ratio: float | None
        method: str
        if recoverable_mean > 1e-12:
            recovery_ratio = target_mean_delta / recoverable_mean
            method = "paired primary-metric recovery"
        else:
            hard_targets = [
                case_id
                for case_id in plan.target_test_case_ids
                if baseline[case_id].passed and not candidate[case_id].passed
            ]
            if hard_targets:
                recovery_ratio = sum(
                    1 for case_id in hard_targets if ablation[case_id].passed
                ) / len(hard_targets)
                method = "paired pass/fail recovery because metric headroom was zero"
            else:
                recovery_ratio = None
                method = "no measurable recovery denominator"

        config = bundle.detection
        enough_targets = len(plan.target_test_case_ids) >= config.min_target_cases
        enough_controls = len(plan.control_test_case_ids) >= config.min_control_cases
        if (
            enough_targets
            and enough_controls
            and recovery_ratio is not None
            and recovery_ratio >= config.support_recovery_ratio
            and max_observed_control_damage <= config.max_control_damage
            and unrecovered_hard_targets == 0
            and new_control_failures == 0
        ):
            status = HypothesisStatus.SUPPORTED
            stance = EvidenceStance.SUPPORTING
            outcome = "support gate passed"
        elif (
            enough_targets
            and recovery_ratio is not None
            and (
                recovery_ratio <= config.reject_recovery_ratio
                or target_mean_delta < 0.0
            )
        ):
            status = HypothesisStatus.REJECTED
            stance = EvidenceStance.CONTRADICTING
            outcome = "rejection gate passed"
        else:
            status = HypothesisStatus.INCONCLUSIVE
            stance = (
                EvidenceStance.CONTRADICTING
                if max_observed_control_damage > config.max_control_damage
                or new_control_failures > 0
                else EvidenceStance.NEUTRAL
            )
            outcome = "evidence did not cross a decision gate"

        rationale = (
            f"{outcome}; method={method}; target_n={len(target_deltas)}; "
            f"target_mean_delta={target_mean_delta:.6f}; "
            f"recovery_ratio={recovery_ratio if recovery_ratio is not None else 'null'}; "
            f"control_n={len(control_deltas)}; "
            f"max_control_damage={max_observed_control_damage:.6f}; "
            f"unrecovered_hard_targets={unrecovered_hard_targets}; "
            f"new_control_failures={new_control_failures}; "
            f"minimums=target:{config.min_target_cases},control:{config.min_control_cases}."
        )
        descriptor = {
            "hypothesis_id": hypothesis.id,
            "cluster_id": cluster.id,
            "run_id": run.id,
            "metric_key": metric_key,
            "target_case_ids": list(plan.target_test_case_ids),
            "control_case_ids": list(plan.control_test_case_ids),
            "target_mean_delta": target_mean_delta,
            "control_mean_delta": control_mean_delta,
            "max_observed_control_damage": max_observed_control_damage,
            "recovery_ratio": recovery_ratio,
            "unrecovered_hard_targets": unrecovered_hard_targets,
            "new_control_failures": new_control_failures,
            "status": status.value,
        }
        return Evidence(
            id=stable_id("evidence", descriptor),
            hypothesis_id=hypothesis.id,
            cluster_id=cluster.id,
            prompt_change_ids=hypothesis.prompt_change_ids,
            ablation_run_id=run.id,
            metric_key=metric_key,
            stance=stance,
            resulting_status=status,
            target_case_ids=plan.target_test_case_ids,
            control_case_ids=plan.control_test_case_ids,
            target_mean_delta=round(target_mean_delta, 12),
            control_mean_delta=round(control_mean_delta, 12),
            max_observed_control_damage=round(
                max_observed_control_damage, 12
            ),
            recovery_ratio=(
                round(recovery_ratio, 12) if recovery_ratio is not None else None
            ),
            target_sample_size=len(target_deltas),
            control_sample_size=len(control_deltas),
            unrecovered_hard_targets=unrecovered_hard_targets,
            new_control_failures=new_control_failures,
            rationale=rationale,
        )


def apply_evidence_status(
    hypothesis: RootCauseHypothesis, evidence: Evidence
) -> RootCauseHypothesis:
    if hypothesis.id != evidence.hypothesis_id:
        raise PipelineInvariantError("Evidence references a different hypothesis")
    return replace(hypothesis, verification_status=evidence.resulting_status)


def _tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9_\-]+|[\u4e00-\u9fff]+", value.lower())
        if len(token) > 1
    }

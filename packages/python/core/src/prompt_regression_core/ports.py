"""Public extension ports.

Stable Core owns these protocols. Adapters depend on the protocols; Core never
imports provider, database, queue, UI, or observability SDKs.
"""

from __future__ import annotations

from typing import Any, Mapping, Protocol, Sequence, runtime_checkable

from .model import (
    AblationPlan,
    AblationRun,
    AblationVariant,
    DiagnosisReport,
    EvalResult,
    Evidence,
    FailureCluster,
    PromptChange,
    PromptSegment,
    PromptVersion,
    Regression,
    RegressionBundle,
    RootCauseHypothesis,
    TestCase,
)


@runtime_checkable
class EvalImporter(Protocol):
    """Translate an external evaluation export into a canonical bundle."""

    def import_bundle(self, source: Any) -> RegressionBundle: ...


@runtime_checkable
class TraceImporter(Protocol):
    """Attach vendor-neutral trace facts to known test cases."""

    def import_traces(self, source: Any) -> Mapping[str, Mapping[str, Any]]: ...


@runtime_checkable
class ProviderAdapter(Protocol):
    """Generate outputs for a prompt version without leaking provider types."""

    def generate(
        self, prompt_version: PromptVersion, test_cases: Sequence[TestCase]
    ) -> Sequence[str]: ...


@runtime_checkable
class EvaluatorAdapter(Protocol):
    """Score outputs and return canonical evaluation results."""

    def evaluate(
        self, test_cases: Sequence[TestCase], outputs: Sequence[str]
    ) -> Sequence[EvalResult]: ...


@runtime_checkable
class FailureClusterer(Protocol):
    name: str
    version: str

    def cluster(
        self, regression: Regression, bundle: RegressionBundle
    ) -> Sequence[FailureCluster]: ...


@runtime_checkable
class PromptParser(Protocol):
    name: str
    version: str

    def parse(self, raw_prompt: str) -> Sequence[PromptSegment]: ...


@runtime_checkable
class SemanticDiffStrategy(Protocol):
    name: str
    version: str

    def diff(
        self, baseline: PromptVersion, candidate: PromptVersion
    ) -> Sequence[PromptChange]: ...


@runtime_checkable
class RootCauseStrategy(Protocol):
    name: str
    version: str

    def propose(
        self,
        clusters: Sequence[FailureCluster],
        changes: Sequence[PromptChange],
        bundle: RegressionBundle,
    ) -> Sequence[RootCauseHypothesis]: ...


@runtime_checkable
class AblationStrategy(Protocol):
    name: str
    version: str

    def plan(
        self,
        hypothesis: RootCauseHypothesis,
        cluster: FailureCluster,
        changes: Sequence[PromptChange],
        bundle: RegressionBundle,
    ) -> tuple[AblationPlan, Sequence[AblationVariant]]: ...


@runtime_checkable
class AblationRunner(Protocol):
    name: str
    version: str

    def run(
        self,
        plan: AblationPlan,
        variant: AblationVariant,
        bundle: RegressionBundle,
    ) -> AblationRun: ...


@runtime_checkable
class EvidenceScorer(Protocol):
    name: str
    version: str

    def score(
        self,
        hypothesis: RootCauseHypothesis,
        cluster: FailureCluster,
        plan: AblationPlan,
        run: AblationRun,
        changes: Sequence[PromptChange],
        bundle: RegressionBundle,
    ) -> Evidence: ...


@runtime_checkable
class Reporter(Protocol):
    """Render a typed report into a presentation format."""

    name: str
    version: str

    def render(self, report: DiagnosisReport) -> str: ...

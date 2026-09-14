"""Human-readable reporters for diagnosis results."""

from __future__ import annotations

from html import escape
import re

from .model import DiagnosisReport, HypothesisStatus


_STATUS_LABELS = {
    HypothesisStatus.HYPOTHESIZED: "HYPOTHESIZED (not yet verified)",
    HypothesisStatus.SUPPORTED: "SUPPORTED by controlled evidence",
    HypothesisStatus.REJECTED: "REJECTED by controlled evidence",
    HypothesisStatus.INCONCLUSIVE: "INCONCLUSIVE",
}


class MarkdownReporter:
    """Render a deterministic report for maintainers and pull-request reviews."""

    name = "markdown"
    version = "1.0.0"

    def render(self, report: DiagnosisReport) -> str:
        lines = [
            "# Prompt regression diagnosis",
            "",
            "> A hypothesis is not a root cause until a controlled ablation supports it.",
            "",
            "## Outcome",
            "",
            f"- Regression cases: {len(report.regression.cases)}",
            f"- Prompt changes: {len(report.prompt_changes)}",
            f"- Failure clusters: {len(report.failure_clusters)}",
            f"- Supported hypotheses: {_status_count(report, HypothesisStatus.SUPPORTED)}",
            f"- Rejected hypotheses: {_status_count(report, HypothesisStatus.REJECTED)}",
            f"- Inconclusive hypotheses: {_status_count(report, HypothesisStatus.INCONCLUSIVE)}",
            f"- Unverified hypotheses: {_status_count(report, HypothesisStatus.HYPOTHESIZED)}",
            "",
            "## Reproducibility",
            "",
            f"- Report ID: {_code_span(report.report_id)}",
            f"- Bundle ID: {_code_span(report.bundle_id)}",
            f"- Input bundle hash: {_code_span(report.input_bundle_hash)}",
            "- Pipeline: "
            + _code_span(
                f"{report.pipeline.engine}@{report.pipeline.engine_version}"
            ),
            f"- Pipeline config hash: {_code_span(report.pipeline.config_hash)}",
            f"- Report timestamp: {_code_span(report.generated_at)}",
            "",
            "## Prompt changes",
            "",
        ]

        if report.prompt_changes:
            lines.extend(("| Segment | Change | Summary |", "| --- | --- | --- |"))
            for change in report.prompt_changes:
                lines.append(
                    "| "
                    + " | ".join(
                        (
                            _table(change.segment_id),
                            _table(change.change_type.value),
                            _table(change.semantic_summary),
                        )
                    )
                    + " |"
                )
        else:
            lines.append("No prompt changes were detected.")

        lines.extend(("", "## Hypotheses and evidence", ""))
        if not report.hypotheses:
            lines.append("No root-cause hypotheses were proposed.")
        else:
            evidence_by_hypothesis = {
                hypothesis.id: [
                    item
                    for item in report.evidence
                    if item.hypothesis_id == hypothesis.id
                ]
                for hypothesis in report.hypotheses
            }
            for index, hypothesis in enumerate(report.hypotheses, start=1):
                lines.extend(
                    (
                        f"### {index}. {_STATUS_LABELS[hypothesis.verification_status]}",
                        "",
                        _paragraph(hypothesis.mechanism),
                        "",
                        f"Expected test: {_paragraph(hypothesis.expected_if_reverted)}",
                        "",
                    )
                )
                evidence_items = evidence_by_hypothesis[hypothesis.id]
                if not evidence_items:
                    lines.extend(
                        (
                            "No ablation evidence is attached. This remains only a hypothesis.",
                            "",
                        )
                    )
                    continue
                lines.extend(
                    (
                        "| Evidence stance | Metric | Target Δ | Recovery | "
                        "Control mean Δ | Worst control damage | Hard targets left | "
                        "New control failures | Samples |",
                        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
                    )
                )
                for item in evidence_items:
                    recovery = (
                        "n/a" if item.recovery_ratio is None else f"{item.recovery_ratio:.3f}"
                    )
                    lines.append(
                        "| "
                        + " | ".join(
                            (
                                _table(item.stance.value),
                                _table(item.metric_key),
                                f"{item.target_mean_delta:+.3f}",
                                recovery,
                                f"{item.control_mean_delta:+.3f}",
                                f"{item.max_observed_control_damage:.3f}",
                                str(item.unrecovered_hard_targets),
                                str(item.new_control_failures),
                                f"target={item.target_sample_size}, "
                                f"control={item.control_sample_size}",
                            )
                        )
                        + " |"
                    )
                lines.append("")

        lines.extend(("## Recommended next actions", ""))
        if report.recommendations:
            lines.extend(f"- {_paragraph(item)}" for item in report.recommendations)
        else:
            lines.append("No follow-up action was generated.")
        return "\n".join(lines).rstrip() + "\n"


def _status_count(report: DiagnosisReport, status: HypothesisStatus) -> int:
    return sum(
        1 for hypothesis in report.hypotheses if hypothesis.verification_status is status
    )


def _code_span(value: str) -> str:
    normalized = escape(value, quote=False).replace("\r", " ").replace("\n", " ")
    longest_run = max(
        (len(item) for item in re.findall(r"`+", normalized)),
        default=0,
    )
    delimiter = "`" * (longest_run + 1)
    padding = " " if normalized.startswith("`") or normalized.endswith("`") else ""
    return f"{delimiter}{padding}{normalized}{padding}{delimiter}"


def _paragraph(value: str) -> str:
    return (
        escape(value, quote=False)
        .replace("\\", "\\\\")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace("\r", " ")
        .replace("\n", " ")
    )


def _table(value: str) -> str:
    return (
        escape(value, quote=False)
        .replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("\r", " ")
        .replace("\n", "<br>")
    )

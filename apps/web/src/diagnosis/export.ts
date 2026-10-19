import type { DiagnosisReport } from "./types";

export type ReportFormat = "json" | "markdown" | "csv";

function csvCell(value: string | number | boolean): string {
  let text = String(value);
  if (typeof value === "string" && (/^[\s]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function renderReportExport(report: DiagnosisReport, format: ReportFormat): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  if (format === "csv") {
    const rows: (string | number | boolean)[][] = [
      [
        "report_id",
        "input_bundle_hash",
        "test_case_id",
        "kind",
        "baseline_passed",
        "candidate_passed",
        "primary_metric",
        "primary_delta",
      ],
      ...report.regression.cases.map((item) => [
        report.report_id,
        report.input_bundle_hash,
        item.test_case_id,
        item.kind,
        item.baseline_passed,
        item.candidate_passed,
        item.primary_metric,
        item.metric_deltas[item.primary_metric] ?? "",
      ]),
    ];
    return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
  // User text is inside a code fence longer than any fence in that text.
  // It cannot introduce links, HTML or extra Markdown structure when shared.
  const text = [
    `Report: ${report.report_id}`,
    `Input hash: ${report.input_bundle_hash}`,
    `Baseline: ${report.baseline_prompt_version_id}`,
    `Candidate: ${report.candidate_prompt_version_id}`,
    `Regression cases: ${report.regression.cases.length}`,
    "",
    "Hypotheses (status describes evidence, not a permanent causal claim):",
    ...report.hypotheses.map(
      (item) =>
        `[${item.verification_status}] ${item.mechanism}\nExpected test: ${item.expected_if_reverted}`,
    ),
    "",
    "Evidence:",
    ...report.evidence.map(
      (item) =>
        `${item.hypothesis_id}: ${item.stance}; recovery=${item.recovery_ratio ?? "unknown"}; worst control damage=${item.max_observed_control_damage}; unrecovered hard cases=${item.unrecovered_hard_targets}; new control failures=${item.new_control_failures}\n${item.rationale}`,
    ),
    "",
    "Recommendations:",
    ...report.recommendations,
  ].join("\n");
  const longestFence = Math.max(2, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return `# Prompt regression diagnosis\n\n${fence}text\n${text}\n${fence}\n`;
}

export function downloadReport(report: DiagnosisReport, format: ReportFormat): void {
  const extension = { json: "json", markdown: "md", csv: "csv" }[format];
  const mime = { json: "application/json", markdown: "text/markdown", csv: "text/csv" }[format];
  const url = URL.createObjectURL(
    new Blob([renderReportExport(report, format)], { type: `${mime};charset=utf-8` }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `diagnosis-${report.report_id.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 100)}.${extension}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

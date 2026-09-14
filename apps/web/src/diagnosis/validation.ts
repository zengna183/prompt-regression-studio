import {
  CANONICAL_BUNDLE_VERSION,
  DIAGNOSIS_REPORT_VERSION,
  type CanonicalRegressionBundle,
  type DiagnosisReport,
  type DiagnosisRunDetail,
  type DiagnosisRunStatus,
  type DiagnosisRunSummary,
  type Evidence,
  type EvidenceStance,
  type FailureCluster,
  type HypothesisStatus,
  type PromptChange,
  type PromptChangeType,
  type RegressionCase,
  type RootCauseHypothesis,
} from "./types";

export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export type BundleValidationResult =
  | { readonly ok: true; readonly bundle: CanonicalRegressionBundle }
  | { readonly ok: false; readonly message: string };

export class DiagnosisResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosisResponseError";
  }
}

export function parseCanonicalBundleText(
  source: string,
  maxBytes = MAX_BUNDLE_BYTES,
): BundleValidationResult {
  if (!source.trim()) {
    return { ok: false, message: "评测包是空的，请选择包含 JSON 数据的文件。" };
  }
  if (new TextEncoder().encode(source).byteLength > maxBytes) {
    return {
      ok: false,
      message: `评测包超过 ${formatBytes(maxBytes)}，请缩小数据集或从命令行运行诊断。`,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return { ok: false, message: "文件不是有效的 JSON，请检查是否缺少逗号或括号。" };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "评测包根节点必须是一个 JSON 对象。" };
  }
  if (value.schema_version !== CANONICAL_BUNDLE_VERSION) {
    return {
      ok: false,
      message: `只支持 ${CANONICAL_BUNDLE_VERSION}，当前文件版本不匹配。`,
    };
  }
  if (
    typeof value.bundle_id !== "string" ||
    value.bundle_id.length === 0 ||
    value.bundle_id.length > 256 ||
    /\s/u.test(value.bundle_id)
  ) {
    return { ok: false, message: "评测包缺少有效的 bundle_id（不能包含空白字符）。" };
  }
  return { ok: true, bundle: value as CanonicalRegressionBundle };
}

export function parseDiagnosisReport(value: unknown): DiagnosisReport {
  const root = record(value, "$response");
  if (root.schema_version !== DIAGNOSIS_REPORT_VERSION) {
    throw new DiagnosisResponseError("诊断服务返回了不受支持的报告版本。请升级前后端后重试。");
  }

  const regressionRaw = record(root.regression, "$response.regression");
  const pipelineRaw = record(root.pipeline, "$response.pipeline");
  return {
    schema_version: DIAGNOSIS_REPORT_VERSION,
    report_id: text(root.report_id, "$response.report_id"),
    bundle_id: text(root.bundle_id, "$response.bundle_id"),
    input_bundle_hash: text(root.input_bundle_hash, "$response.input_bundle_hash"),
    generated_at: text(root.generated_at, "$response.generated_at"),
    pipeline: {
      engine: text(pipelineRaw.engine, "$response.pipeline.engine"),
      engine_version: text(pipelineRaw.engine_version, "$response.pipeline.engine_version"),
      config_hash: text(pipelineRaw.config_hash, "$response.pipeline.config_hash"),
    },
    baseline_prompt_version_id: text(
      root.baseline_prompt_version_id,
      "$response.baseline_prompt_version_id",
    ),
    candidate_prompt_version_id: text(
      root.candidate_prompt_version_id,
      "$response.candidate_prompt_version_id",
    ),
    regression: {
      id: text(regressionRaw.id, "$response.regression.id"),
      baseline_eval_run_id: text(
        regressionRaw.baseline_eval_run_id,
        "$response.regression.baseline_eval_run_id",
      ),
      candidate_eval_run_id: text(
        regressionRaw.candidate_eval_run_id,
        "$response.regression.candidate_eval_run_id",
      ),
      config_hash: text(regressionRaw.config_hash, "$response.regression.config_hash"),
      cases: array(regressionRaw.cases, "$response.regression.cases").map((item, index) =>
        parseRegressionCase(item, `$response.regression.cases[${index}]`),
      ),
    },
    prompt_changes: array(root.prompt_changes, "$response.prompt_changes").map((item, index) =>
      parsePromptChange(item, `$response.prompt_changes[${index}]`),
    ),
    failure_clusters: array(root.failure_clusters, "$response.failure_clusters").map(
      (item, index) => parseFailureCluster(item, `$response.failure_clusters[${index}]`),
    ),
    hypotheses: array(root.hypotheses, "$response.hypotheses").map((item, index) =>
      parseHypothesis(item, `$response.hypotheses[${index}]`),
    ),
    ablation_plans: array(root.ablation_plans, "$response.ablation_plans"),
    ablation_variants: array(root.ablation_variants, "$response.ablation_variants"),
    ablation_runs: array(root.ablation_runs, "$response.ablation_runs"),
    evidence: array(root.evidence, "$response.evidence").map((item, index) =>
      parseEvidence(item, `$response.evidence[${index}]`),
    ),
    recommendations: stringArray(root.recommendations, "$response.recommendations"),
  };
}

export function parseDiagnosisRunList(value: unknown): readonly DiagnosisRunSummary[] {
  const root = record(value, "$response");
  return array(root.items, "$response.items").map((item, index) =>
    parseDiagnosisRunSummary(item, `$response.items[${index}]`),
  );
}

export function parseDiagnosisRunDetail(value: unknown): DiagnosisRunDetail {
  const path = "$response";
  const item = record(value, path);
  const summary = parseDiagnosisRunSummary(item, path);
  const report = item.report === null ? null : parseDiagnosisReport(item.report);
  if (summary.status === "succeeded" && report === null) {
    throw invalid(`${path}.report`, "成功记录必须包含报告");
  }
  if (summary.status !== "succeeded" && report !== null) {
    throw invalid(`${path}.report`, "非成功记录不能包含报告");
  }
  return { ...summary, report };
}

function parseDiagnosisRunSummary(value: unknown, path: string): DiagnosisRunSummary {
  const item = record(value, path);
  return {
    id: text(item.id, `${path}.id`),
    projectId: nullableText(item.projectId, `${path}.projectId`),
    bundleId: text(item.bundleId, `${path}.bundleId`),
    status: oneOf(
      item.status,
      [
        "running",
        "succeeded",
        "failed",
        "cancelled",
      ] as const satisfies readonly DiagnosisRunStatus[],
      `${path}.status`,
    ),
    inputBundleHash: nullableText(item.inputBundleHash, `${path}.inputBundleHash`),
    reportId: nullableText(item.reportId, `${path}.reportId`),
    failureCode: nullableText(item.failureCode, `${path}.failureCode`),
    failureMessage: nullableText(item.failureMessage, `${path}.failureMessage`),
    createdAt: text(item.createdAt, `${path}.createdAt`),
    startedAt: text(item.startedAt, `${path}.startedAt`),
    completedAt: nullableText(item.completedAt, `${path}.completedAt`),
  };
}

function parseRegressionCase(value: unknown, path: string): RegressionCase {
  const item = record(value, path);
  const kind = oneOf(item.kind, ["hard", "metric", "hard_and_metric"] as const, `${path}.kind`);
  const deltasRaw = record(item.metric_deltas, `${path}.metric_deltas`);
  const metricDeltas: Record<string, number> = {};
  for (const [key, delta] of Object.entries(deltasRaw)) {
    metricDeltas[key] = finiteNumber(delta, `${path}.metric_deltas.${key}`);
  }
  return {
    id: text(item.id, `${path}.id`),
    test_case_id: text(item.test_case_id, `${path}.test_case_id`),
    kind,
    baseline_passed: bool(item.baseline_passed, `${path}.baseline_passed`),
    candidate_passed: bool(item.candidate_passed, `${path}.candidate_passed`),
    metric_deltas: metricDeltas,
    primary_metric: text(item.primary_metric, `${path}.primary_metric`),
  };
}

function parsePromptChange(value: unknown, path: string): PromptChange {
  const item = record(value, path);
  return {
    id: text(item.id, `${path}.id`),
    segment_id: text(item.segment_id, `${path}.segment_id`),
    change_type: oneOf(
      item.change_type,
      ["added", "removed", "rewritten"] as const satisfies readonly PromptChangeType[],
      `${path}.change_type`,
    ),
    old_content: nullableText(item.old_content, `${path}.old_content`),
    new_content: nullableText(item.new_content, `${path}.new_content`),
    old_ordinal: nullableInteger(item.old_ordinal, `${path}.old_ordinal`),
    new_ordinal: nullableInteger(item.new_ordinal, `${path}.new_ordinal`),
    semantic_tags: stringArray(item.semantic_tags, `${path}.semantic_tags`),
    semantic_summary: text(item.semantic_summary, `${path}.semantic_summary`),
  };
}

function parseFailureCluster(value: unknown, path: string): FailureCluster {
  const item = record(value, path);
  return {
    id: text(item.id, `${path}.id`),
    key: text(item.key, `${path}.key`),
    title: text(item.title, `${path}.title`),
    primary_metric: text(item.primary_metric, `${path}.primary_metric`),
    regression_case_ids: stringArray(item.regression_case_ids, `${path}.regression_case_ids`),
    test_case_ids: stringArray(item.test_case_ids, `${path}.test_case_ids`),
    algorithm: text(item.algorithm, `${path}.algorithm`),
    algorithm_version: text(item.algorithm_version, `${path}.algorithm_version`),
  };
}

function parseHypothesis(value: unknown, path: string): RootCauseHypothesis {
  const item = record(value, path);
  return {
    id: text(item.id, `${path}.id`),
    cluster_id: text(item.cluster_id, `${path}.cluster_id`),
    prompt_change_ids: stringArray(item.prompt_change_ids, `${path}.prompt_change_ids`),
    mechanism: text(item.mechanism, `${path}.mechanism`),
    expected_if_reverted: text(item.expected_if_reverted, `${path}.expected_if_reverted`),
    prior_confidence: finiteNumber(item.prior_confidence, `${path}.prior_confidence`),
    verification_status: oneOf(
      item.verification_status,
      [
        "hypothesized",
        "supported",
        "rejected",
        "inconclusive",
      ] as const satisfies readonly HypothesisStatus[],
      `${path}.verification_status`,
    ),
  };
}

function parseEvidence(value: unknown, path: string): Evidence {
  const item = record(value, path);
  return {
    id: text(item.id, `${path}.id`),
    hypothesis_id: text(item.hypothesis_id, `${path}.hypothesis_id`),
    cluster_id: text(item.cluster_id, `${path}.cluster_id`),
    prompt_change_ids: stringArray(item.prompt_change_ids, `${path}.prompt_change_ids`),
    ablation_run_id: text(item.ablation_run_id, `${path}.ablation_run_id`),
    metric_key: text(item.metric_key, `${path}.metric_key`),
    stance: oneOf(
      item.stance,
      ["supporting", "contradicting", "neutral"] as const satisfies readonly EvidenceStance[],
      `${path}.stance`,
    ),
    resulting_status: oneOf(
      item.resulting_status,
      [
        "hypothesized",
        "supported",
        "rejected",
        "inconclusive",
      ] as const satisfies readonly HypothesisStatus[],
      `${path}.resulting_status`,
    ),
    target_case_ids: stringArray(item.target_case_ids, `${path}.target_case_ids`),
    control_case_ids: stringArray(item.control_case_ids, `${path}.control_case_ids`),
    target_mean_delta: finiteNumber(item.target_mean_delta, `${path}.target_mean_delta`),
    control_mean_delta: finiteNumber(item.control_mean_delta, `${path}.control_mean_delta`),
    max_observed_control_damage: finiteNumber(
      item.max_observed_control_damage,
      `${path}.max_observed_control_damage`,
    ),
    recovery_ratio:
      item.recovery_ratio === null
        ? null
        : finiteNumber(item.recovery_ratio, `${path}.recovery_ratio`),
    target_sample_size: integer(item.target_sample_size, `${path}.target_sample_size`),
    control_sample_size: integer(item.control_sample_size, `${path}.control_sample_size`),
    unrecovered_hard_targets: integer(
      item.unrecovered_hard_targets,
      `${path}.unrecovered_hard_targets`,
    ),
    new_control_failures: integer(item.new_control_failures, `${path}.new_control_failures`),
    rationale: text(item.rationale, `${path}.rationale`),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(path, "应为对象");
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid(path, "应为数组");
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(path, "应为非空文本");
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw invalid(path, "应为布尔值");
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(path, "应为有限数字");
  return value;
}

function integer(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalid(path, "应为非负整数");
  return parsed;
}

function nullableInteger(value: unknown, path: string): number | null {
  return value === null ? null : integer(value, path);
}

function stringArray(value: unknown, path: string): readonly string[] {
  return array(value, path).map((item, index) => text(item, `${path}[${index}]`));
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw invalid(path, `应为 ${choices.join("、")} 之一`);
  }
  return value;
}

function invalid(path: string, expectation: string): DiagnosisResponseError {
  return new DiagnosisResponseError(`诊断服务返回的数据不完整（${path} ${expectation}）。`);
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

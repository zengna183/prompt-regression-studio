export const CANONICAL_BUNDLE_VERSION = "prompt-regression.bundle/v1alpha1" as const;
export const DIAGNOSIS_REPORT_VERSION = "prompt-regression.report/v1alpha1" as const;

export interface CanonicalRegressionBundle extends Record<string, unknown> {
  schema_version: typeof CANONICAL_BUNDLE_VERSION;
  bundle_id: string;
}

export type HypothesisStatus = "hypothesized" | "supported" | "rejected" | "inconclusive";
export type EvidenceStance = "supporting" | "contradicting" | "neutral";
export type PromptChangeType = "added" | "removed" | "rewritten";
export type DiagnosisRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface PipelineDescriptor {
  engine: string;
  engine_version: string;
  config_hash: string;
}

export interface RegressionCase {
  id: string;
  test_case_id: string;
  kind: "hard" | "metric" | "hard_and_metric";
  baseline_passed: boolean;
  candidate_passed: boolean;
  metric_deltas: Readonly<Record<string, number>>;
  primary_metric: string;
}

export interface Regression {
  id: string;
  baseline_eval_run_id: string;
  candidate_eval_run_id: string;
  config_hash: string;
  cases: readonly RegressionCase[];
}

export interface PromptChange {
  id: string;
  segment_id: string;
  change_type: PromptChangeType;
  old_content: string | null;
  new_content: string | null;
  old_ordinal: number | null;
  new_ordinal: number | null;
  semantic_tags: readonly string[];
  semantic_summary: string;
}

export interface FailureCluster {
  id: string;
  key: string;
  title: string;
  primary_metric: string;
  regression_case_ids: readonly string[];
  test_case_ids: readonly string[];
  algorithm: string;
  algorithm_version: string;
}

export interface RootCauseHypothesis {
  id: string;
  cluster_id: string;
  prompt_change_ids: readonly string[];
  mechanism: string;
  expected_if_reverted: string;
  prior_confidence: number;
  verification_status: HypothesisStatus;
}

export interface Evidence {
  id: string;
  hypothesis_id: string;
  cluster_id: string;
  prompt_change_ids: readonly string[];
  ablation_run_id: string;
  metric_key: string;
  stance: EvidenceStance;
  resulting_status: HypothesisStatus;
  target_case_ids: readonly string[];
  control_case_ids: readonly string[];
  target_mean_delta: number;
  control_mean_delta: number;
  max_observed_control_damage: number;
  recovery_ratio: number | null;
  target_sample_size: number;
  control_sample_size: number;
  unrecovered_hard_targets: number;
  new_control_failures: number;
  rationale: string;
}

export interface DiagnosisReport {
  schema_version: typeof DIAGNOSIS_REPORT_VERSION;
  report_id: string;
  bundle_id: string;
  input_bundle_hash: string;
  generated_at: string;
  pipeline: PipelineDescriptor;
  baseline_prompt_version_id: string;
  candidate_prompt_version_id: string;
  regression: Regression;
  prompt_changes: readonly PromptChange[];
  failure_clusters: readonly FailureCluster[];
  hypotheses: readonly RootCauseHypothesis[];
  ablation_plans: readonly unknown[];
  ablation_variants: readonly unknown[];
  ablation_runs: readonly unknown[];
  evidence: readonly Evidence[];
  recommendations: readonly string[];
}

export interface DiagnosisRunSummary {
  id: string;
  projectId: string | null;
  bundleId: string;
  status: DiagnosisRunStatus;
  inputBundleHash: string | null;
  reportId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  startedAt: string;
  completedAt: string | null;
}

export interface DiagnosisRunDetail extends DiagnosisRunSummary {
  report: DiagnosisReport | null;
}

import { describe, expect, it } from "vitest";

import { CANONICAL_BUNDLE_VERSION, DIAGNOSIS_REPORT_VERSION } from "./types";
import { canonicalBundleFixture, diagnosisReportFixture } from "./testFixtures";
import {
  DiagnosisResponseError,
  parseCanonicalBundleText,
  parseDiagnosisReport,
  parseDiagnosisRunDetail,
  parseDiagnosisRunList,
} from "./validation";

describe("canonical bundle 网页端校验", () => {
  it("接受版本正确且含有效 bundle_id 的对象，并保留额外数据", () => {
    const result = parseCanonicalBundleText(JSON.stringify(canonicalBundleFixture));

    expect(result).toEqual({ ok: true, bundle: canonicalBundleFixture });
  });

  it.each([
    ["空内容", "   ", "评测包是空的"],
    ["无效 JSON", "{", "不是有效的 JSON"],
    ["非对象根节点", "[]", "根节点必须是一个 JSON 对象"],
    [
      "错误 schema 版本",
      JSON.stringify({ schema_version: "prompt-regression.bundle/v0", bundle_id: "bundle-1" }),
      CANONICAL_BUNDLE_VERSION,
    ],
    [
      "带空白的 bundle_id",
      JSON.stringify({ schema_version: CANONICAL_BUNDLE_VERSION, bundle_id: "bundle 1" }),
      "bundle_id",
    ],
  ])("拒绝%s", (_name, source, expectedMessage) => {
    const result = parseCanonicalBundleText(source);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(expectedMessage);
  });

  it("按 UTF-8 字节数执行上传大小限制", () => {
    const source = JSON.stringify(canonicalBundleFixture);
    const byteLength = new TextEncoder().encode(source).byteLength;

    const result = parseCanonicalBundleText(source, byteLength - 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("超过");
  });
});

describe("诊断报告响应校验", () => {
  it("解析完整报告并保留归因证据关键字段", () => {
    const report = parseDiagnosisReport(diagnosisReportFixture);

    expect(report.schema_version).toBe(DIAGNOSIS_REPORT_VERSION);
    expect(report.regression.cases).toHaveLength(1);
    expect(report.evidence[0]).toMatchObject({
      max_observed_control_damage: 0.04,
      unrecovered_hard_targets: 1,
      new_control_failures: 2,
    });
  });

  it("拒绝不受支持的报告版本", () => {
    expect(() =>
      parseDiagnosisReport({
        ...diagnosisReportFixture,
        schema_version: "prompt-regression.report/v0",
      }),
    ).toThrow(DiagnosisResponseError);
  });

  it("拒绝缺少最坏对照损伤字段的不完整证据", () => {
    const evidenceWithoutWorstControlDamage = diagnosisReportFixture.evidence.map((item) => {
      const evidence = { ...item } as Partial<typeof item>;
      delete evidence.max_observed_control_damage;
      return evidence;
    });

    expect(() =>
      parseDiagnosisReport({
        ...diagnosisReportFixture,
        evidence: evidenceWithoutWorstControlDamage,
      }),
    ).toThrow(/max_observed_control_damage/);
  });

  it("拒绝未知的假设状态", () => {
    const invalidHypotheses = diagnosisReportFixture.hypotheses.map((hypothesis, index) =>
      index === 0 ? { ...hypothesis, verification_status: "certain" } : hypothesis,
    );

    expect(() =>
      parseDiagnosisReport({ ...diagnosisReportFixture, hypotheses: invalidHypotheses }),
    ).toThrow(/verification_status/);
  });
});

describe("诊断历史响应校验", () => {
  const summary = {
    id: "run-1",
    projectId: null,
    bundleId: "bundle-1",
    status: "succeeded",
    inputBundleHash: "a".repeat(64),
    reportId: "report-1",
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    startedAt: "2026-09-14T00:00:00.000Z",
    completedAt: "2026-09-14T00:00:01.000Z",
  } as const;

  it("解析历史列表和成功报告", () => {
    expect(parseDiagnosisRunList({ items: [summary] })).toEqual([summary]);
    expect(parseDiagnosisRunDetail({ ...summary, report: diagnosisReportFixture })).toEqual({
      ...summary,
      report: diagnosisReportFixture,
    });
  });

  it("拒绝缺少报告的成功记录", () => {
    expect(() => parseDiagnosisRunDetail({ ...summary, report: null })).toThrow(/成功记录/);
  });

  it("拒绝携带报告的失败记录", () => {
    expect(() =>
      parseDiagnosisRunDetail({
        ...summary,
        status: "failed",
        inputBundleHash: null,
        reportId: null,
        failureCode: "ENGINE_FAILED",
        failureMessage: "retry",
        report: diagnosisReportFixture,
      }),
    ).toThrow(/非成功记录/);
  });
});

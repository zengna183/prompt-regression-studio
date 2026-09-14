import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { diagnosisReportFixture } from "../diagnosis/testFixtures";
import { DiagnosisReportView, isSupportedRootCause } from "./DiagnosisReport";

describe("诊断报告", () => {
  it("用中文展示回归、Prompt 变化、证据风险和下一步建议", () => {
    const html = renderToStaticMarkup(<DiagnosisReportView report={diagnosisReportFixture} />);

    expect(html).toContain("回归用例");
    expect(html).toContain("Prompt 改动");
    expect(html).toContain("退款规则被跳过");
    expect(html).toContain("目标恢复");
    expect(html).toContain("最坏对照损伤");
    expect(html).toContain("仍有 1 个硬回归未恢复");
    expect(html).toContain("出现 2 个新的对照失败");
    expect(html).toContain("恢复退款核验区段后，使用相同配置重新评测。");
  });

  it("只把有匹配支持性消融证据的假设称为已支持根因", () => {
    const supported = diagnosisReportFixture.hypotheses[0];
    const pending = diagnosisReportFixture.hypotheses[1];

    expect(supported).toBeDefined();
    expect(pending).toBeDefined();
    if (!supported || !pending) return;

    expect(isSupportedRootCause(supported, diagnosisReportFixture.evidence)).toBe(true);
    expect(isSupportedRootCause(supported, [])).toBe(false);
    expect(isSupportedRootCause(pending, diagnosisReportFixture.evidence)).toBe(false);
  });

  it("报告宣称 supported 但缺少匹配证据时降级为候选假设并给出警告", () => {
    const reportWithoutEvidence = { ...diagnosisReportFixture, evidence: [] };

    const html = renderToStaticMarkup(<DiagnosisReportView report={reportWithoutEvidence} />);

    expect(html).not.toContain("<h3>已支持根因</h3>");
    expect(html).toContain("<h3>候选假设</h3>");
    expect(html).toContain("报告状态虽为“支持”，但没有对应的支持性消融证据");
    expect(html).toContain("尚无消融证据，不能称为根因");
  });
});

import { describe, expect, it } from "vitest";
import { diagnosisReportFixture } from "./testFixtures";
import { renderReportExport } from "./export";

describe("报告导出", () => {
  it("完整 JSON 保留证据与输入指纹", () => {
    expect(JSON.parse(renderReportExport(diagnosisReportFixture, "json"))).toEqual(
      diagnosisReportFixture,
    );
  });
  it("CSV 防止公式注入且保留负数分差", () => {
    const report = {
      ...diagnosisReportFixture,
      regression: {
        ...diagnosisReportFixture.regression,
        cases: [
          {
            ...diagnosisReportFixture.regression.cases[0]!,
            test_case_id: '=HYPERLINK("evil")',
            primary_metric: "@metric",
            metric_deltas: { "@metric": -0.8 },
          },
        ],
      },
    };
    const csv = renderReportExport(report, "csv");
    expect(csv).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(csv).toContain(`"'@metric","-0.8"`);
    expect(csv).toContain(report.input_bundle_hash);
  });
  it("可读摘要保留证据状态且围住不可信 Markdown", () => {
    const report = {
      ...diagnosisReportFixture,
      recommendations: ["```\n<script>evil()</script>\n[click](https://evil.example)"],
    };
    const markdown = renderReportExport(report, "markdown");
    expect(markdown).toContain("````text\n");
    expect(markdown).toContain("[supported]");
    expect(markdown).toContain("worst control damage=");
    expect(markdown.endsWith("````\n")).toBe(true);
  });
});

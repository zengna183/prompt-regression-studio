import { describe, expect, it } from "vitest";
import { importTemplates, parseImportPreview, summarizeImportValue } from "./datasetImport";

const preview = {
  previewHash: "a".repeat(64),
  totalRows: 1,
  validRows: 1,
  errorCount: 0,
  canImport: true,
  issuesTruncated: false,
  issues: [],
  previewRows: [{ row: 1, case: { caseKey: "a", input: "你好" } }],
};
describe("导入预览校验", () => {
  it("接受真实结构的预览和错误行", () => {
    expect(parseImportPreview(preview)).toEqual(preview);
    expect(
      parseImportPreview({
        ...preview,
        canImport: false,
        errorCount: 1,
        issues: [{ row: 2, field: "input", message: "输入不能为空" }],
      }).canImport,
    ).toBe(false);
  });
  it.each([
    null,
    [],
    { ...preview, previewHash: "bad" },
    { ...preview, issues: [{}] },
    { ...preview, validRows: 2 },
    { ...preview, errorCount: 1 },
    { ...preview, previewRows: [{}] },
    { ...preview, previewRows: [{ row: 0, case: {} }] },
  ])("拒绝畸形响应", (value) => {
    expect(() => parseImportPreview(value)).toThrow("格式不正确");
  });
  it("模板包含可编辑用例，显示长文本时不会撑开页面", () => {
    expect(JSON.parse(importTemplates.json)).toEqual([
      expect.objectContaining({ input: "你好", caseKey: "greeting-001" }),
    ]);
    expect(importTemplates.csv).toContain("caseKey,name,input,expectedOutput");
    expect(summarizeImportValue({ question: "你好" })).toBe('{"question":"你好"}');
    expect(summarizeImportValue("x".repeat(500))).toHaveLength(301);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DatasetImport, DatasetImportPreviewView } from "./DatasetImport";

describe("导入界面", () => {
  it("默认要求先预览并说明草稿不自动发布", () => {
    const html = renderToStaticMarkup(<DatasetImport datasetId="dataset" onSaved={() => {}} />);
    expect(html).toContain("校验并预览");
    expect(html).toContain("不会自动发布");
    expect(html).toContain("UTF-8");
    expect(html).not.toContain("确认保存全部用例为草稿");
  });
  it("显示错误记录、禁止部分导入，按文本安全显示恶意输入", () => {
    const html = renderToStaticMarkup(
      <DatasetImportPreviewView
        preview={{
          previewHash: "a".repeat(64),
          totalRows: 2,
          validRows: 1,
          errorCount: 1,
          canImport: false,
          issuesTruncated: true,
          issues: [{ row: 2, field: "input", message: "输入不能为空" }],
          previewRows: [{ row: 1, case: { caseKey: "a", input: '<script>alert("x")</script>' } }],
        }}
      />,
    );
    expect(html).toContain("记录 2");
    expect(html).toContain("不会只保存通过的部分");
    expect(html).toContain("前 100 个");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

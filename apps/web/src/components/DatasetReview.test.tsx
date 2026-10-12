import { renderToStaticMarkup } from "react-dom/server";
import type { DatasetVersion } from "@ai-chat-eval/contracts";
import { describe, expect, it } from "vitest";

import { DatasetReview } from "./DatasetReview";

const version: DatasetVersion = {
  id: "5d63d006-b8df-4d39-b07a-cb44cf149250",
  datasetId: "72453c7a-297c-453e-8057-5dd2f626b281",
  version: 1,
  status: "draft",
  source: "ai_generated",
  contentHash: "a".repeat(64),
  caseCount: 1,
  generationProvenance: { model: "test" },
  parentVersionId: null,
  changeSummary: null,
  createdAt: new Date().toISOString(),
  publishedAt: null,
  reviewedAt: null,
  reviewedBy: null,
  reviewNotes: null,
};

describe("评测用例审核界面", () => {
  it("未审核草稿不显示发布按钮", () => {
    const html = renderToStaticMarkup(<DatasetReview version={version} onChanged={() => {}} />);
    expect(html).toContain("逐条查看并勾选确认");
    expect(html).not.toContain("发布已审核版本");
  });

  it("已审核版本显示发布入口并安全转义自填审核人", () => {
    const html = renderToStaticMarkup(
      <DatasetReview
        version={{
          ...version,
          reviewedAt: new Date().toISOString(),
          reviewedBy: "<script>x</script>",
        }}
        onChanged={() => {}}
      />,
    );
    expect(html).toContain("发布已审核版本");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

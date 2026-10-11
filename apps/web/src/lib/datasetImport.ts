import type { DatasetImportPreview } from "@ai-chat-eval/contracts";

export const IMPORT_LIMIT_BYTES = 2 * 1024 * 1024;
export const importTemplates = {
  json: JSON.stringify(
    [
      {
        caseKey: "greeting-001",
        name: "中文问候",
        input: "你好",
        expectedOutput: "友好地回应问候",
        metadata: { topic: "greeting" },
      },
    ],
    null,
    2,
  ),
  csv: 'caseKey,name,input,expectedOutput\ngreeting-001,中文问候,你好,友好地回应问候\nrefund-001,退款咨询,"我想退款,怎么办？",说明退款流程\n',
};

export function parseImportPreview(value: unknown): DatasetImportPreview {
  function invalid(): never {
    throw new Error("服务端返回的导入预览格式不正确，请重试。");
  }
  if (!isObject(value)) return invalid();
  const integer = (item: unknown) =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  if (
    typeof value.previewHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.previewHash) ||
    !integer(value.totalRows) ||
    !integer(value.validRows) ||
    !integer(value.errorCount) ||
    typeof value.canImport !== "boolean" ||
    typeof value.issuesTruncated !== "boolean" ||
    !Array.isArray(value.issues) ||
    value.issues.length > 100 ||
    !Array.isArray(value.previewRows) ||
    value.previewRows.length > 20
  )
    return invalid();
  if (
    Number(value.validRows) > Number(value.totalRows) ||
    value.issues.length > Number(value.errorCount) ||
    (value.canImport &&
      (value.errorCount !== 0 || value.validRows === 0 || value.validRows !== value.totalRows))
  )
    return invalid();
  for (const issue of value.issues) {
    if (
      !isObject(issue) ||
      !integer(issue.row) ||
      typeof issue.field !== "string" ||
      typeof issue.message !== "string"
    )
      return invalid();
  }
  for (const row of value.previewRows) {
    if (
      !isObject(row) ||
      !integer(row.row) ||
      row.row === 0 ||
      !isObject(row.case) ||
      typeof row.case.caseKey !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(row.case.caseKey) ||
      !Object.hasOwn(row.case, "input") ||
      row.case.input === null ||
      (row.case.name !== undefined && typeof row.case.name !== "string")
    )
      return invalid();
  }
  return value as unknown as DatasetImportPreview;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function summarizeImportValue(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "—");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

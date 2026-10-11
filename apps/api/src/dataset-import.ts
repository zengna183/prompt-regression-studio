import { createHash } from "node:crypto";

import {
  EvaluationCaseInputSchema,
  type DatasetImportPreview,
  type DatasetImportPreviewRequest,
  type EvaluationCaseInput,
} from "@ai-chat-eval/contracts";
import {
  normalizeEvaluationCases,
  type EvaluationCaseInput as DatabaseCase,
} from "@ai-chat-eval/db";
import { Value } from "@sinclair/typebox/value";
import { parse, CsvError } from "csv-parse/sync";

export const DATASET_IMPORT_VERSION = "dataset-import/v1";
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_CASES = 5000;
const fields = new Set(["caseKey", "name", "input", "expectedOutput", "metadata"]);
const csvFields = new Set([
  "caseKey",
  "name",
  "input",
  "inputJson",
  "expectedOutput",
  "expectedOutputJson",
  "metadataJson",
]);

class RowError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/** Pure, bounded parser. A failed preview never becomes a partially imported dataset. */
export function parseDatasetImport(input: DatasetImportPreviewRequest): {
  preview: DatasetImportPreview;
  cases: EvaluationCaseInput[];
} {
  const preview: DatasetImportPreview = {
    previewHash: createHash("sha256")
      .update(`${DATASET_IMPORT_VERSION}\0${input.format}\0${input.content}`)
      .digest("hex"),
    totalRows: 0,
    validRows: 0,
    errorCount: 0,
    canImport: false,
    issuesTruncated: false,
    issues: [],
    previewRows: [],
  };
  const cases: EvaluationCaseInput[] = [];
  const keys = new Set<string>();
  function issue(row: number, field: string, message: string) {
    preview.errorCount++;
    if (preview.issues.length < 100) preview.issues.push({ row, field, message });
    else preview.issuesTruncated = true;
  }
  function accept(value: unknown, row: number, index: number) {
    try {
      if (!isObject(value)) throw new RowError("row", "每条用例必须是对象。");
      if (Object.keys(value).some((key) => !fields.has(key)))
        throw new RowError("row", "存在未知字段，请使用模板中的字段名。");
      const item = {
        ...value,
        caseKey: Object.hasOwn(value, "caseKey")
          ? value.caseKey
          : `case-${String(index + 1).padStart(6, "0")}`,
      };
      if (typeof item.caseKey === "string") item.caseKey = item.caseKey.trim();
      if (
        !Object.hasOwn(value, "input") ||
        value.input === null ||
        (typeof value.input === "string" && !value.input.trim())
      )
        throw new RowError("input", "输入不能为空。");
      assertJsonTree(item);
      if (!Value.Check(EvaluationCaseInputSchema, item)) {
        const first = Value.Errors(EvaluationCaseInputSchema, item).First();
        throw new RowError(
          first?.path.split("/")[1] || "row",
          "字段格式不正确，请检查编号、名称和 metadata 对象。",
        );
      }
      const [normalized] = normalizeEvaluationCases([item as DatabaseCase]);
      if (!normalized) throw new RowError("row", "用例无法规范化。");
      if (keys.has(normalized.caseKey))
        throw new RowError("caseKey", "用例编号重复，请为每条用例设置不同编号。");
      keys.add(normalized.caseKey);
      const result: EvaluationCaseInput = {
        caseKey: normalized.caseKey,
        ...(normalized.name === null ? {} : { name: normalized.name }),
        input: normalized.input,
        expectedOutput: normalized.expectedOutput,
        metadata: normalized.metadata,
      };
      cases.push(result);
      preview.validRows++;
      if (preview.previewRows.length < 20) preview.previewRows.push({ row, case: result });
    } catch (error) {
      issue(
        row,
        error instanceof RowError ? error.field : "row",
        error instanceof RowError
          ? error.message
          : "字段超过大小、数量或格式限制，请缩小这条用例。",
      );
    }
  }
  if (Buffer.byteLength(input.content, "utf8") > MAX_IMPORT_BYTES) {
    issue(0, "content", "文件超过 2 MiB，请拆分后导入。");
    return { preview, cases };
  }
  try {
    if (input.format === "json") {
      let rows: unknown;
      try {
        rows = JSON.parse(input.content.replace(/^\uFEFF/u, ""));
      } catch {
        throw new RowError("content", "JSON 无法解析，请检查括号、引号和逗号。");
      }
      if (!Array.isArray(rows)) throw new RowError("content", "JSON 顶层必须是用例数组。");
      preview.totalRows = rows.length;
      if (rows.length > MAX_CASES)
        throw new RowError("content", "最多导入 5000 条用例，请拆分文件。");
      rows.forEach((value, index) => accept(value, index + 1, index));
    } else {
      // Do not infer numeric values, evaluate formulas, or silently discard malformed rows.
      const rows = parse(input.content, {
        bom: true,
        columns: false,
        skip_empty_lines: true,
        relax_column_count: true,
        max_record_size: 1_000_000,
        to: MAX_CASES + 2,
      });
      const header = rows[0]?.map((cell) => cell.trim()) ?? [];
      if (
        header.length === 0 ||
        header.some((key) => !csvFields.has(key)) ||
        new Set(header).size !== header.length
      )
        throw new RowError("header", "CSV 表头为空、重复或含未知列，请使用模板。");
      if (
        Number(header.includes("input")) + Number(header.includes("inputJson")) !== 1 ||
        (header.includes("expectedOutput") && header.includes("expectedOutputJson"))
      )
        throw new RowError(
          "header",
          "input 与 inputJson 必须且只能选择一种；预期输出也不能同时使用两种格式。",
        );
      preview.totalRows = rows.length - 1;
      if (preview.totalRows > MAX_CASES)
        throw new RowError("content", "最多导入 5000 条用例，请拆分文件。");
      for (const [index, cells] of rows.slice(1).entries()) {
        const row = index + 2;
        try {
          if (cells.length !== header.length)
            throw new RowError("row", "这一条记录的列数与表头不一致。");
          const values = Object.fromEntries(
            header.map((key, column) => [key, cells[column] ?? ""]),
          );
          const value: Record<string, unknown> = {
            input: header.includes("input")
              ? values.input
              : jsonCell(values.inputJson, "inputJson"),
          };
          if (values.caseKey?.trim()) value.caseKey = values.caseKey.trim();
          if (values.name?.trim()) value.name = values.name.trim();
          if (header.includes("expectedOutput")) value.expectedOutput = values.expectedOutput;
          if (values.expectedOutputJson?.trim())
            value.expectedOutput = jsonCell(values.expectedOutputJson, "expectedOutputJson");
          if (values.metadataJson?.trim())
            value.metadata = jsonCell(values.metadataJson, "metadataJson");
          accept(value, row, index);
        } catch (error) {
          issue(
            row,
            error instanceof RowError ? error.field : "row",
            error instanceof RowError ? error.message : "CSV 记录格式不正确。",
          );
        }
      }
    }
    if (preview.totalRows === 0) issue(0, "content", "文件中没有用例。");
  } catch (error) {
    issue(
      error instanceof RowError && error.field === "header" ? 1 : 0,
      error instanceof RowError ? error.field : "content",
      error instanceof RowError
        ? error.message
        : error instanceof CsvError
          ? "CSV 引号或记录格式不正确，或单条记录过大。请检查分隔符和模板。"
          : "文件无法解析。",
    );
  }
  preview.canImport = preview.errorCount === 0 && cases.length > 0;
  return { preview, cases };
}

function jsonCell(value: string | undefined, field: string): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    throw new RowError(field, "这一格不是合法 JSON，请检查引号和括号。");
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertJsonTree(value: unknown): void {
  const stack = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (++visited > 100_000 || current.depth > 32)
      throw new RowError("row", "数据嵌套过深或字段过多，请简化这条用例。");
    if (typeof current.value === "number" && !Number.isFinite(current.value))
      throw new RowError("row", "数字超出范围。");
    if (current.value && typeof current.value === "object") {
      if (Object.keys(current.value).length + stack.length + visited > 100_000)
        throw new RowError("row", "数据字段过多，请简化这条用例。");
      for (const [key, child] of Object.entries(current.value)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw new RowError("row", "数据包含不安全的保留字段名。");
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

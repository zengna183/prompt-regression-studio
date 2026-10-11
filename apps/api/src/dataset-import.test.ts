import { describe, expect, it } from "vitest";
import { parseDatasetImport, MAX_IMPORT_BYTES } from "./dataset-import.js";

const json = (rows: unknown) =>
  parseDatasetImport({ format: "json", content: JSON.stringify(rows) });
const csv = (content: string) => parseDatasetImport({ format: "csv", content });

describe("dataset import parser", () => {
  it("normalizes JSON, generates missing keys and preserves input and reference types", () => {
    const result = json([
      { input: "你好", expectedOutput: "你好！" },
      { caseKey: " b ", input: { question: "退款" }, metadata: { topic: "refund" } },
    ]);
    expect(result.preview).toMatchObject({
      totalRows: 2,
      validRows: 2,
      canImport: true,
      errorCount: 0,
    });
    expect(result.cases[0]).toMatchObject({
      caseKey: "case-000001",
      input: "你好",
      expectedOutput: "你好！",
    });
    expect(result.cases[1]).toMatchObject({
      caseKey: "b",
      input: { question: "退款" },
      metadata: { topic: "refund" },
    });
    expect(result.preview.previewHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result).toEqual(
      json([
        { input: "你好", expectedOutput: "你好！" },
        { caseKey: " b ", input: { question: "退款" }, metadata: { topic: "refund" } },
      ]),
    );
  });
  it("supports BOM, CRLF, quoted commas, escaped quotes and multiline CSV without casts", () => {
    const result = csv(
      '\uFEFFcaseKey,input,expectedOutput\r\n001,"你好,\r\n""朋友""",=1+1\r\n002,000123,ok\r\n',
    );
    expect(result.preview.canImport).toBe(true);
    expect(result.cases[0]).toMatchObject({
      caseKey: "001",
      input: '你好,\r\n"朋友"',
      expectedOutput: "=1+1",
    });
    expect(result.cases[1]?.input).toBe("000123");
  });
  it("parses JSON-valued CSV cells only in explicitly named JSON columns", () => {
    const result = csv(
      'inputJson,expectedOutputJson,metadataJson\n"{""q"":""你好""}","{""ok"":true}","{""tag"":""hello""}"',
    );
    expect(result.preview.canImport).toBe(true);
    expect(result.cases[0]).toMatchObject({
      input: { q: "你好" },
      expectedOutput: { ok: true },
      metadata: { tag: "hello" },
    });
    expect(csv("inputJson\nnot-json").preview.issues).toMatchObject([
      { row: 2, field: "inputJson" },
    ]);
  });
  it("reports invalid rows and duplicate normalized keys without allowing partial import", () => {
    const result = json([
      { input: "good", caseKey: "a" },
      { input: "duplicate", caseKey: " a " },
      { input: " " },
      { input: "bad", unknown: "ignored?" },
      { input: "bad", caseKey: null },
    ]);
    expect(result.preview).toMatchObject({ validRows: 1, errorCount: 4, canImport: false });
    expect(result.preview.issues.map((issue) => issue.row)).toEqual([2, 3, 4, 5]);
  });
  it.each([
    "",
    "[]",
    "{}",
    "[",
    '[{"input":null}]',
    '[{"input":"x","metadata":[]}]',
    '[{"input":1e999}]',
    '[{"input":{"__proto__":{"polluted":true}}}]',
  ])("rejects invalid, empty or unsafe JSON: %s", (content) => {
    expect(parseDatasetImport({ format: "json", content }).preview.canImport).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it.each([
    "input,input\nx,x",
    "unknown\nx",
    "input,inputJson\nx,{}",
    "caseKey\nx",
    "input,expectedOutput,expectedOutputJson\nx,x,x",
    'input\n"unterminated',
    "input,name\nx",
    "input\nx,extra",
  ])("rejects ambiguous headers, malformed quotes and mismatched columns: %s", (content) => {
    expect(csv(content).preview.canImport).toBe(false);
  });
  it("caps issues, previews, source bytes, record counts and nested input", () => {
    expect(json(Array.from({ length: 200 }, () => ({ input: null }))).preview).toMatchObject({
      errorCount: 200,
      issuesTruncated: true,
    });
    expect(json(Array.from({ length: 200 }, () => ({ input: null }))).preview.issues).toHaveLength(
      100,
    );
    expect(
      json(Array.from({ length: 25 }, () => ({ input: "hello" }))).preview.previewRows,
    ).toHaveLength(20);
    expect(json(Array.from({ length: 5001 }, () => ({ input: "hello" }))).preview.canImport).toBe(
      false,
    );
    expect(csv("input\n" + "hello\n".repeat(5001)).preview.canImport).toBe(false);
    expect(
      parseDatasetImport({ format: "json", content: "中".repeat(Math.ceil(MAX_IMPORT_BYTES / 3)) })
        .preview.issues[0]?.message,
    ).toContain("2 MiB");
    const deeplyNested: unknown = JSON.parse("[".repeat(40) + "0" + "]".repeat(40));
    expect(json([{ input: deeplyNested }]).preview.canImport).toBe(false);
    expect(
      json([
        {
          input: "x",
          metadata: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), true])),
        },
      ]).preview.canImport,
    ).toBe(false);
  });
  it("changes the fingerprint when content or format changes", () => {
    expect(json([{ input: "a" }]).preview.previewHash).not.toBe(
      json([{ input: "b" }]).preview.previewHash,
    );
    expect(
      parseDatasetImport({ format: "json", content: "input\nx" }).preview.previewHash,
    ).not.toBe(csv("input\nx").preview.previewHash);
  });
});

import { describe, expect, it } from "vitest";

import {
  normalizeDiagnosisBundleId,
  normalizeDiagnosisFailure,
  normalizeDiagnosisHash,
  normalizeDiagnosisReportId,
} from "./repositories/diagnoses.js";

describe("diagnosis persistence validation", () => {
  it("normalizes stable bundle, report, and hash identifiers", () => {
    expect(normalizeDiagnosisBundleId(" bundle-1 ")).toBe("bundle-1");
    expect(normalizeDiagnosisReportId(" report_1 ")).toBe("report_1");
    expect(normalizeDiagnosisHash("A".repeat(64))).toBe("a".repeat(64));
  });

  it.each(["", "contains whitespace", "x".repeat(257)])(
    "rejects invalid bundle identifiers: %s",
    (value) => {
      expect(() => normalizeDiagnosisBundleId(value)).toThrow(TypeError);
    },
  );

  it("rejects malformed hashes and report identifiers", () => {
    expect(() => normalizeDiagnosisHash("not-a-hash")).toThrow(TypeError);
    expect(() => normalizeDiagnosisReportId("report id")).toThrow(TypeError);
  });

  it("normalizes safe public failure details and bounds their size", () => {
    expect(normalizeDiagnosisFailure(" engine_timeout ", " Please retry ")).toEqual({
      code: "ENGINE_TIMEOUT",
      message: "Please retry",
    });
    expect(() => normalizeDiagnosisFailure("bad-code", "message")).toThrow(TypeError);
    expect(() => normalizeDiagnosisFailure("ENGINE_ERROR", "x".repeat(2_001))).toThrow(TypeError);
  });
});

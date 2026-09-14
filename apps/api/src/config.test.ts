import { describe, expect, it } from "vitest";

import { loadApiConfig } from "./config.js";

describe("loadApiConfig", () => {
  it("provides safe diagnosis process defaults", () => {
    const config = loadApiConfig({});

    expect(config.DIAGNOSIS_PYTHON_EXECUTABLE).toBe("python");
    expect(config.DIAGNOSIS_PYTHONPATH).toBeUndefined();
    expect(config.DIAGNOSIS_TIMEOUT_MS).toBe(120_000);
    expect(config.DIAGNOSIS_MAX_CONCURRENCY).toBe(2);
  });

  it.each([
    ["DIAGNOSIS_MAX_CONCURRENCY", "0"],
    ["DIAGNOSIS_MAX_CONCURRENCY", "129"],
    ["DIAGNOSIS_MAX_CONCURRENCY", "not-a-number"],
    ["DIAGNOSIS_TIMEOUT_MS", "0"],
    ["DIAGNOSIS_TIMEOUT_MS", "2147483648"],
    ["DIAGNOSIS_TIMEOUT_MS", "not-a-number"],
  ] as const)("rejects invalid %s=%s", (name, value) => {
    expect(() => loadApiConfig({ [name]: value })).toThrow();
  });

  it("coerces explicit deployment values", () => {
    const config = loadApiConfig({
      DIAGNOSIS_PYTHON_EXECUTABLE: "/srv/venv/bin/python",
      DIAGNOSIS_PYTHONPATH: "/srv/prompt-regression/core",
      DIAGNOSIS_TIMEOUT_MS: "45000",
      DIAGNOSIS_MAX_CONCURRENCY: "4",
    });

    expect(config).toMatchObject({
      DIAGNOSIS_PYTHON_EXECUTABLE: "/srv/venv/bin/python",
      DIAGNOSIS_PYTHONPATH: "/srv/prompt-regression/core",
      DIAGNOSIS_TIMEOUT_MS: 45_000,
      DIAGNOSIS_MAX_CONCURRENCY: 4,
    });
  });
});

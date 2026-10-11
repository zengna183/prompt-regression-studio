import { describe, expect, it } from "vitest";

import { loadApiConfig } from "./config.js";

describe("loadApiConfig", () => {
  it("provides safe diagnosis process defaults", () => {
    const config = loadApiConfig({});

    expect(config.DIAGNOSIS_PYTHON_EXECUTABLE).toBe("python");
    expect(config.DIAGNOSIS_PYTHONPATH).toBeUndefined();
    expect(config.DIAGNOSIS_TIMEOUT_MS).toBe(120_000);
    expect(config.DIAGNOSIS_MAX_CONCURRENCY).toBe(2);
    expect(config.API_AUTH_TOKEN).toBeUndefined();
    expect(config.API_BODY_LIMIT_BYTES).toBe(8 * 1024 * 1024);
    expect(config.API_DOCS_ENABLED).toBe(true);
    expect(config.API_RATE_LIMIT_MAX).toBe(120);
    expect(config.DIAGNOSIS_RATE_LIMIT_MAX).toBe(10);
    expect(config.API_TRUST_PROXY).toBe(false);
    expect(config.DATASET_GENERATION_MODEL).toBeUndefined();
  });

  it("requires a strong API token and hides API docs in production", () => {
    expect(() => loadApiConfig({ NODE_ENV: "production" })).toThrow();

    const config = loadApiConfig({
      NODE_ENV: "production",
      API_AUTH_TOKEN: "a".repeat(32),
      WEB_ORIGIN: "https://eval.example.com",
    });

    expect(config.API_AUTH_TOKEN).toBe("a".repeat(32));
    expect(config.API_DOCS_ENABLED).toBe(false);
  });

  it("allows production docs only when explicitly enabled", () => {
    const config = loadApiConfig({
      NODE_ENV: "production",
      API_AUTH_TOKEN: "b".repeat(32),
      API_DOCS_ENABLED: "true",
      WEB_ORIGIN: "https://eval.example.com",
    });

    expect(config.API_DOCS_ENABLED).toBe(true);
  });

  it.each([
    ["DIAGNOSIS_MAX_CONCURRENCY", "0"],
    ["DIAGNOSIS_MAX_CONCURRENCY", "129"],
    ["DIAGNOSIS_MAX_CONCURRENCY", "not-a-number"],
    ["DIAGNOSIS_TIMEOUT_MS", "0"],
    ["DIAGNOSIS_TIMEOUT_MS", "2147483648"],
    ["DIAGNOSIS_TIMEOUT_MS", "not-a-number"],
    ["API_AUTH_TOKEN", "too-short"],
    ["API_AUTH_TOKEN", " ".repeat(32)],
    ["API_BODY_LIMIT_BYTES", "1023"],
    ["API_RATE_LIMIT_MAX", "0"],
    ["API_RATE_LIMIT_WINDOW_MS", "999"],
    ["API_TRUST_PROXY", "yes"],
  ] as const)("rejects invalid %s=%s", (name, value) => {
    expect(() => loadApiConfig({ [name]: value })).toThrow();
  });

  it("requires a safe HTTPS web origin in production", () => {
    expect(() => loadApiConfig({ WEB_ORIGIN: "file:///tmp/site" })).toThrow(/WEB_ORIGIN/);
    expect(() =>
      loadApiConfig({
        NODE_ENV: "production",
        API_AUTH_TOKEN: "c".repeat(32),
        WEB_ORIGIN: "http://eval.example.com",
      }),
    ).toThrow(/WEB_ORIGIN/);
  });

  it("rejects a diagnosis limit that is weaker than the global limit", () => {
    expect(() =>
      loadApiConfig({ API_RATE_LIMIT_MAX: "5", DIAGNOSIS_RATE_LIMIT_MAX: "6" }),
    ).toThrow();
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

  it("validates optional AI case-generation deployment settings", () => {
    expect(loadApiConfig({ DATASET_GENERATION_MODEL: "small-model" })).toMatchObject({
      DATASET_GENERATION_MODEL: "small-model",
      MODEL_PROVIDER_TIMEOUT_MS: 60_000,
    });
    expect(() => loadApiConfig({ MODEL_PROVIDER_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadApiConfig({ MODEL_PROVIDER_ALLOW_PRIVATE_NETWORK: "yes" })).toThrow();
    expect(() =>
      loadApiConfig({
        NODE_ENV: "production",
        API_AUTH_TOKEN: "a".repeat(32),
        WEB_ORIGIN: "https://eval.example.com",
        DATASET_GENERATION_MODEL: "model",
      }),
    ).toThrow(/MODEL_PROVIDER_API_KEY/u);
    expect(
      loadApiConfig({
        NODE_ENV: "production",
        API_AUTH_TOKEN: "a".repeat(32),
        WEB_ORIGIN: "https://eval.example.com",
        DATASET_GENERATION_MODEL: "model",
        MODEL_PROVIDER_API_KEY: "real-key",
      }).DATASET_GENERATION_MODEL,
    ).toBe("model");
  });
});

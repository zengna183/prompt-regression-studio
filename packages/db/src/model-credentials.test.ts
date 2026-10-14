import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decryptModelApiKey,
  encryptModelApiKey,
  parseModelEncryptionKey,
} from "./model-credentials.js";

const projectId = "0ca2c262-9705-4141-bba5-7a4218fd049c";
const connectionId = "a2ab148a-a689-4bd5-8467-eb50eb8566d5";

describe("model credentials", () => {
  it("encrypts with a random nonce and binds ciphertext to project and connection", () => {
    const key = parseModelEncryptionKey(randomBytes(32).toString("base64"));
    const first = encryptModelApiKey("secret-test-key", key, projectId, connectionId);
    const second = encryptModelApiKey("secret-test-key", key, projectId, connectionId);
    expect(first).not.toBe(second);
    expect(first).not.toContain("secret-test-key");
    expect(decryptModelApiKey(first, key, projectId, connectionId)).toBe("secret-test-key");
    expect(() =>
      decryptModelApiKey(first, key, projectId, randomBytes(16).toString("hex")),
    ).toThrow();
    expect(() => decryptModelApiKey(first, randomBytes(32), projectId, connectionId)).toThrow();
  });

  it("rejects missing or malformed deployment keys", () => {
    expect(() => parseModelEncryptionKey(undefined)).toThrow();
    expect(() => parseModelEncryptionKey("replace-with-a-32-byte-secret")).toThrow();
  });
});

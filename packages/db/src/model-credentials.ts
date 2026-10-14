import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const LEGACY_MODEL_ENCRYPTION_PLACEHOLDER =
  "replace-with-a-32-byte-secret-before-storing-provider-keys";

/** Older .env templates had an inert placeholder; preserve their legacy-only setup. */
export function optionalModelEncryptionKey(encoded: string | undefined): Buffer | undefined {
  if (!encoded || encoded === LEGACY_MODEL_ENCRYPTION_PLACEHOLDER) return undefined;
  return parseModelEncryptionKey(encoded);
}

/** A single deployment key, not a user password. Back it up separately from PostgreSQL. */
export function parseModelEncryptionKey(encoded: string | undefined): Buffer {
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) {
    throw new Error("MODEL_ENCRYPTION_KEY must be a base64-encoded 32-byte random key");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("MODEL_ENCRYPTION_KEY must be a base64-encoded 32-byte random key");
  }
  return key;
}

function associatedData(projectId: string, connectionId: string): Buffer {
  return Buffer.from(`model-connection:v1:${projectId}:${connectionId}`, "utf8");
}

export function encryptModelApiKey(
  apiKey: string,
  key: Buffer,
  projectId: string,
  connectionId: string,
): string {
  if (apiKey.length < 8 || apiKey.length > 4096 || /[\r\n]/u.test(apiKey)) {
    throw new TypeError("The provider API key must be 8-4096 characters without line breaks");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData(projectId, connectionId));
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return `v1:${nonce.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptModelApiKey(
  value: string,
  key: Buffer,
  projectId: string,
  connectionId: string,
): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unsupported model credential format");
  }
  const nonce = Buffer.from(parts[1] ?? "", "base64");
  const tag = Buffer.from(parts[2] ?? "", "base64");
  if (nonce.length !== 12 || tag.length !== 16) {
    throw new Error("Invalid model credential format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(associatedData(projectId, connectionId));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3] ?? "", "base64")),
    decipher.final(),
  ]).toString("utf8");
}

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP's scrypt baseline: N=2^17, r=8, p=1 (128 MiB per operation).
// Fixed, versioned parameters prevent malicious stored strings requesting unbounded work.
const PREFIX = "scrypt-v1$131072$8$1$";
const options = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const HASH_PATTERN = /^scrypt-v1\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const DUMMY = `${PREFIX}${"0".repeat(32)}$${"0".repeat(64)}`;
let activeDerivations = 0;

export class PasswordCapacityError extends Error {
  constructor() {
    super("Password verification capacity exceeded; retry later.");
  }
}

export function validatePassword(password: string): void {
  const length = [...password].length;
  if (length < 15 || length > 128 || Buffer.byteLength(password, "utf8") > 512) {
    throw new TypeError("Password must contain 15-128 characters and at most 512 UTF-8 bytes.");
  }
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Bound expensive operations per process; HTTP rate limiting is also required at integration.
  if (activeDerivations >= 2) throw new PasswordCapacityError();
  activeDerivations++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, options, (error, result) =>
        error ? reject(error) : resolve(result),
      );
    });
  } finally {
    activeDerivations--;
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `${PREFIX}${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** A missing or malformed account still pays the same password-derivation cost. */
export async function verifyPassword(
  password: string,
  storedHash: string | null,
): Promise<boolean> {
  const bounded = Buffer.byteLength(password, "utf8") <= 512 && [...password].length <= 128;
  const parsed = HASH_PATTERN.exec(storedHash ?? "");
  const parts = parsed ?? HASH_PATTERN.exec(DUMMY)!;
  const derived = await derive(
    bounded ? password : "invalid-password",
    Buffer.from(parts[1]!, "hex"),
  );
  const matches = timingSafeEqual(derived, Buffer.from(parts[2]!, "hex"));
  return bounded && parsed !== null && matches;
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  // SHA-256 is appropriate for random 256-bit session tokens, not human passwords.
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeAccountEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (
    value.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(value)
  ) {
    throw new TypeError("A valid email address is required.");
  }
  return value;
}

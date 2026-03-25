import crypto from "crypto";

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
const MAX_PASSWORD_LEN = 4096;
export const MAX_SHARE_PASSWORD_LEN = 256;
const MAX_STORED_HASH_LEN = 512;
const PASSWORD_CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/u;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function passwordCharLength(password: string): number {
  return Array.from(String(password || "")).length;
}

export function hasUnsupportedPasswordChars(password: string): boolean {
  return PASSWORD_CONTROL_CHAR_RE.test(String(password || ""));
}

/**
 * Passwords are matched exactly as entered.
 * We intentionally do not trim or Unicode-normalize them because that can
 * create surprising login/share mismatches across create and verify paths.
 */
export function normalizeExactPasswordInput(value: unknown, maxLen = MAX_PASSWORD_LEN): string | null {
  const raw = String(value ?? "");
  if (!raw) return null;
  if (passwordCharLength(raw) > maxLen) return null;
  if (hasUnsupportedPasswordChars(raw)) return null;
  return raw;
}

export function parseOptionalExactPasswordInput(
  value: unknown,
  maxLen = MAX_PASSWORD_LEN
): string | null | "INVALID" {
  const raw = String(value ?? "");
  if (!raw) return null;
  return normalizeExactPasswordInput(raw, maxLen) ?? "INVALID";
}

export function isSafePasswordCandidate(password: string, maxLen = MAX_PASSWORD_LEN): boolean {
  return normalizeExactPasswordInput(password, maxLen) !== null;
}

export function hashPassword(password: string): string {
  const raw = normalizeExactPasswordInput(password, MAX_PASSWORD_LEN);
  if (!raw || !isSafePasswordCandidate(raw)) {
    throw new Error("INVALID_PASSWORD");
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(raw, salt, SCRYPT_KEYLEN);
  return `scrypt$${b64url(salt)}$${b64url(derived)}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const rawPassword = String(password || "");
  if (!isSafePasswordCandidate(rawPassword)) return false;
  const rawStored = String(storedHash || "").trim();
  if (!rawStored || rawStored.length > MAX_STORED_HASH_LEN || /[\r\n\0]/.test(rawStored)) return false;

  const parts = rawStored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  try {
    const salt = fromB64url(parts[1]);
    const expected = fromB64url(parts[2]);
    if (salt.length !== SALT_BYTES) return false;
    if (expected.length !== SCRYPT_KEYLEN) return false;
    const actual = crypto.scryptSync(rawPassword, salt, expected.length);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

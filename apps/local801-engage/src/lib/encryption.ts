import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { getEncryptionConfig } from "./config.ts";

const ENVELOPE_FORMAT = "local801.encrypted";
const ENVELOPE_VERSION = 1;
const ALGORITHM = "AES-256-GCM";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const envelopeSchema = z
  .object({
    format: z.literal(ENVELOPE_FORMAT),
    version: z.literal(ENVELOPE_VERSION),
    algorithm: z.literal(ALGORITHM),
    keyVersion: z.string().min(1).max(32),
    iv: z.string().regex(canonicalBase64),
    tag: z.string().regex(canonicalBase64),
    ciphertext: z.string().regex(canonicalBase64),
  })
  .strict();

export type DecryptedEnvelope = {
  plaintext: Buffer;
  keyVersion: string;
  formatVersion: number;
};

export type EncryptedEnvelope = {
  payload: Buffer;
  keyVersion: string;
  formatVersion: number;
};

function additionalAuthenticatedData(keyVersion: string) {
  return Buffer.from(`${ENVELOPE_FORMAT}:${ENVELOPE_VERSION}:${ALGORITHM}:${keyVersion}`, "utf8");
}

function decodeCanonicalBase64(value: string, field: string) {
  if (!canonicalBase64.test(value)) throw new Error(`Encrypted payload ${field} is not valid base64.`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`Encrypted payload ${field} is not canonical base64.`);
  return decoded;
}

export function getActiveEncryptionKeyVersion(env: NodeJS.ProcessEnv = process.env) {
  return getEncryptionConfig(env).activeVersion;
}

export function validateEncryptionConfig(env: NodeJS.ProcessEnv = process.env): { encryption: "ok" | "error" } {
  try {
    getEncryptionConfig(env);
    return { encryption: "ok" };
  } catch {
    return { encryption: "error" };
  }
}

/** Encrypts bytes into a versioned, self-describing UTF-8 JSON envelope. */
export function encryptEnvelope(
  plaintext: Buffer | Uint8Array,
  env: NodeJS.ProcessEnv = process.env,
): EncryptedEnvelope {
  const { keys, activeVersion } = getEncryptionConfig(env);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", keys[activeVersion], iv);
  cipher.setAAD(additionalAuthenticatedData(activeVersion));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = Buffer.from(
    JSON.stringify({
      format: ENVELOPE_FORMAT,
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      keyVersion: activeVersion,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }),
    "utf8",
  );
  return { payload, keyVersion: activeVersion, formatVersion: ENVELOPE_VERSION };
}

export function encryptData(plaintext: Buffer | Uint8Array, env: NodeJS.ProcessEnv = process.env) {
  return encryptEnvelope(plaintext, env).payload;
}

export function decryptEnvelope(
  payload: Buffer | Uint8Array | string,
  env: NodeJS.ProcessEnv = process.env,
): DecryptedEnvelope {
  let parsedJson: unknown;
  try {
    const serialized = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
    parsedJson = JSON.parse(serialized);
  } catch {
    throw new Error("Unsupported encrypted payload format.");
  }

  const parsed = envelopeSchema.safeParse(parsedJson);
  if (!parsed.success) throw new Error("Unsupported encrypted payload format.");

  const { keys } = getEncryptionConfig(env);
  const key = keys[parsed.data.keyVersion];
  if (!key) throw new Error("Unknown encryption key version.");

  const iv = decodeCanonicalBase64(parsed.data.iv, "IV");
  const tag = decodeCanonicalBase64(parsed.data.tag, "authentication tag");
  const ciphertext = decodeCanonicalBase64(parsed.data.ciphertext, "ciphertext");
  if (iv.byteLength !== IV_LENGTH || tag.byteLength !== TAG_LENGTH) {
    throw new Error("Invalid encrypted payload.");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(additionalAuthenticatedData(parsed.data.keyVersion));
    decipher.setAuthTag(tag);
    return {
      plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      keyVersion: parsed.data.keyVersion,
      formatVersion: parsed.data.version,
    };
  } catch {
    throw new Error("Encrypted payload authentication failed.");
  }
}

export function decryptData(payload: Buffer | Uint8Array | string, env: NodeJS.ProcessEnv = process.env) {
  return decryptEnvelope(payload, env).plaintext;
}

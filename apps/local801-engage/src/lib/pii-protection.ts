import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const KEY_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const DOMAIN_RE = /^[a-z0-9][a-z0-9._:-]{0,95}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELD_FORMAT_VERSION = 1;
const CURSOR_FORMAT_VERSION = 1;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_CURSOR_BYTES = 4 * 1024;
const MAX_KEY_VERSIONS = 8;
const HKDF_SALT = Buffer.from("local801-pii-hkdf-salt:v1", "utf8");

export type PiiKeyConfiguration = Readonly<{
  encryptionKeys: ReadonlyMap<string, Buffer>;
  activeEncryptionKeyVersion: string;
  blindIndexKeys: ReadonlyMap<string, Buffer>;
  activeBlindIndexKeyVersion: string;
}>;

export type PiiFieldContext = Readonly<{
  organizationId: string;
  entity: string;
  recordId: string;
  field: string;
}>;

export type EncryptedPiiField = Readonly<{
  encryptedPayload: string;
  encryptionKeyVersion: string;
  encryptionFormatVersion: 1;
}>;

export type PiiBlindIndex = Readonly<{
  blindIndex: string;
  blindIndexKeyVersion: string;
}>;

export type PiiSearchToken = Readonly<{
  tokenHash: string;
  tokenKeyVersion: string;
  tokenKind: "word" | "prefix";
}>;

export class PiiProtectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PiiProtectionError";
    this.code = code;
  }
}

function requireDomain(value: string, label: string) {
  if (!DOMAIN_RE.test(value)) throw new PiiProtectionError("INVALID_CONTEXT", `${label} is invalid.`);
  return value;
}

function requireUuid(value: string, label: string) {
  if (!UUID_RE.test(value)) throw new PiiProtectionError("INVALID_CONTEXT", `${label} is invalid.`);
  return value.toLowerCase();
}

function parseCanonicalBase64Key(value: unknown, label: string) {
  if (typeof value !== "string" || value.length < 40 || value.length > 48) {
    throw new PiiProtectionError("INVALID_KEY", `${label} must be a canonical base64-encoded 32-byte key.`);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new PiiProtectionError("INVALID_KEY", `${label} must be canonical base64.`);
  }
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new PiiProtectionError("INVALID_KEY", `${label} must be a canonical base64-encoded 32-byte key.`);
  }
  return decoded;
}

function parseKeyring(raw: string | undefined, label: string) {
  if (!raw) throw new PiiProtectionError("KEYRING_MISSING", `${label} is required.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PiiProtectionError("KEYRING_INVALID", `${label} must be a one-line JSON object.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PiiProtectionError("KEYRING_INVALID", `${label} must be a JSON object.`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_KEY_VERSIONS) {
    throw new PiiProtectionError("KEYRING_INVALID", `${label} must contain between 1 and ${MAX_KEY_VERSIONS} key versions.`);
  }
  const keys = new Map<string, Buffer>();
  const keyFingerprints = new Set<string>();
  try {
    for (const [version, encoded] of entries) {
      if (!KEY_VERSION_RE.test(version)) throw new PiiProtectionError("KEY_VERSION_INVALID", `${label} contains an invalid key version.`);
      const key = parseCanonicalBase64Key(encoded, `${label}.${version}`);
      const fingerprint = createHmac("sha256", Buffer.from("local801-keyring-duplicate-check", "utf8")).update(key).digest("hex");
      if (keyFingerprints.has(fingerprint)) {
        key.fill(0);
        throw new PiiProtectionError("DUPLICATE_KEY", `${label} must not reuse the same key material under multiple versions.`);
      }
      keyFingerprints.add(fingerprint);
      keys.set(version, key);
    }
    return keys;
  } catch (error) {
    for (const key of keys.values()) key.fill(0);
    throw error;
  }
}

function requireActiveVersion(value: string | undefined, keys: ReadonlyMap<string, Buffer>, label: string) {
  const version = value?.trim() ?? "";
  if (!KEY_VERSION_RE.test(version) || !keys.has(version)) {
    throw new PiiProtectionError("ACTIVE_KEY_INVALID", `${label} must name a configured key version.`);
  }
  return version;
}

export function getPiiKeyConfiguration(env: NodeJS.ProcessEnv = process.env): PiiKeyConfiguration {
  const encryptionKeys = parseKeyring(env.LOCAL801_PII_ENCRYPTION_MASTER_KEYS, "LOCAL801_PII_ENCRYPTION_MASTER_KEYS");
  const blindIndexKeys = parseKeyring(env.LOCAL801_PII_BLIND_INDEX_KEYS, "LOCAL801_PII_BLIND_INDEX_KEYS");
  try {
    return Object.freeze({
      encryptionKeys,
      activeEncryptionKeyVersion: requireActiveVersion(env.LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION, encryptionKeys, "LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION"),
      blindIndexKeys,
      activeBlindIndexKeyVersion: requireActiveVersion(env.LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION, blindIndexKeys, "LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION"),
    });
  } catch (error) {
    for (const key of encryptionKeys.values()) key.fill(0);
    for (const key of blindIndexKeys.values()) key.fill(0);
    throw error;
  }
}

export function piiKeyConfigurationValid(env: NodeJS.ProcessEnv = process.env) {
  try {
    getPiiKeyConfiguration(env);
    return true;
  } catch {
    return false;
  }
}

function fieldContext(context: PiiFieldContext, keyVersion: string) {
  const organizationId = requireUuid(context.organizationId, "organizationId");
  const recordId = requireUuid(context.recordId, "recordId");
  const entity = requireDomain(context.entity, "entity");
  const field = requireDomain(context.field, "field");
  return {
    organizationId,
    recordId,
    entity,
    field,
    aad: Buffer.from(`local801-pii-field:v${FIELD_FORMAT_VERSION}|org:${organizationId}|entity:${entity}|record:${recordId}|field:${field}|key:${keyVersion}`, "utf8"),
    hkdfInfo: Buffer.from(`local801-pii-field-key:v1|org:${organizationId}|entity:${entity}|field:${field}`, "utf8"),
  };
}

function derivedAesKey(root: Buffer, info: Buffer) {
  return Buffer.from(hkdfSync("sha256", root, HKDF_SALT, info, 32));
}

function encodeEnvelope(iv: Buffer, ciphertext: Buffer, tag: Buffer) {
  return `p${FIELD_FORMAT_VERSION}.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
}

function decodeEnvelope(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== `p${FIELD_FORMAT_VERSION}`) {
    throw new PiiProtectionError("ENVELOPE_INVALID", "Protected field envelope is invalid.");
  }
  const decode = (part: string) => {
    const buffer = Buffer.from(part, "base64url");
    if (buffer.toString("base64url") !== part) throw new PiiProtectionError("ENVELOPE_INVALID", "Protected field envelope is not canonical.");
    return buffer;
  };
  const iv = decode(parts[1]);
  const ciphertext = decode(parts[2]);
  const tag = decode(parts[3]);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_PLAINTEXT_BYTES + 32) {
    throw new PiiProtectionError("ENVELOPE_INVALID", "Protected field envelope has invalid bounds.");
  }
  return { iv, ciphertext, tag };
}

export function encryptPiiField(
  plaintext: string,
  context: PiiFieldContext,
  config: PiiKeyConfiguration = getPiiKeyConfiguration(),
): EncryptedPiiField {
  if (typeof plaintext !== "string") throw new PiiProtectionError("PLAINTEXT_INVALID", "Protected field value must be a string.");
  const plaintextBytes = Buffer.from(plaintext, "utf8");
  if (plaintextBytes.length > MAX_PLAINTEXT_BYTES) {
    plaintextBytes.fill(0);
    throw new PiiProtectionError("PLAINTEXT_TOO_LARGE", "Protected field value exceeds the maximum size.");
  }
  const keyVersion = config.activeEncryptionKeyVersion;
  const root = config.encryptionKeys.get(keyVersion);
  if (!root) throw new PiiProtectionError("KEY_NOT_FOUND", "Active PII encryption key is unavailable.");
  const derivedContext = fieldContext(context, keyVersion);
  const key = derivedAesKey(root, derivedContext.hkdfInfo);
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(derivedContext.aad);
    const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Object.freeze({
      encryptedPayload: encodeEnvelope(iv, ciphertext, tag),
      encryptionKeyVersion: keyVersion,
      encryptionFormatVersion: FIELD_FORMAT_VERSION,
    });
  } finally {
    key.fill(0);
    plaintextBytes.fill(0);
  }
}

export function decryptPiiField(
  value: Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion">,
  context: PiiFieldContext,
  config: PiiKeyConfiguration = getPiiKeyConfiguration(),
) {
  if (value.encryptionFormatVersion !== FIELD_FORMAT_VERSION || !KEY_VERSION_RE.test(value.encryptionKeyVersion)) {
    throw new PiiProtectionError("ENVELOPE_INVALID", "Protected field version is unsupported.");
  }
  const root = config.encryptionKeys.get(value.encryptionKeyVersion);
  if (!root) throw new PiiProtectionError("KEY_NOT_FOUND", "Required PII encryption key version is unavailable.");
  const decoded = decodeEnvelope(value.encryptedPayload);
  const derivedContext = fieldContext(context, value.encryptionKeyVersion);
  const key = derivedAesKey(root, derivedContext.hkdfInfo);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, decoded.iv);
    decipher.setAAD(derivedContext.aad);
    decipher.setAuthTag(decoded.tag);
    const plaintext = Buffer.concat([decipher.update(decoded.ciphertext), decipher.final()]);
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      plaintext.fill(0);
      throw new PiiProtectionError("PLAINTEXT_TOO_LARGE", "Decrypted protected field exceeds the maximum size.");
    }
    const result = plaintext.toString("utf8");
    plaintext.fill(0);
    return result;
  } catch (error) {
    if (error instanceof PiiProtectionError) throw error;
    throw new PiiProtectionError("AUTHENTICATION_FAILED", "Protected field authentication failed.");
  } finally {
    key.fill(0);
  }
}

function normalizeWhitespace(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function normalizePiiEmail(value: string) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized || normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new PiiProtectionError("NORMALIZATION_FAILED", "Email value is invalid.");
  }
  return normalized;
}

export function normalizePiiIdentifier(value: string) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized.length > 256) throw new PiiProtectionError("NORMALIZATION_FAILED", "Identifier value is invalid.");
  return normalized;
}

export function normalizePiiNameForSearch(value: string) {
  const normalized = normalizeWhitespace(value).toLocaleLowerCase("en-US");
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const result = words.join(" ");
  if (!result || Buffer.byteLength(result, "utf8") > 512) throw new PiiProtectionError("NORMALIZATION_FAILED", "Name search value is invalid.");
  return result;
}

export function normalizePiiContactValue(contactType: string, value: string) {
  if (contactType === "work_email" || contactType === "personal_email") return normalizePiiEmail(value);
  const normalized = normalizeWhitespace(value);
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 4096) throw new PiiProtectionError("NORMALIZATION_FAILED", "Contact value is invalid.");
  return normalized;
}

function blindDomainKey(root: Buffer, organizationId: string, domain: string, version: string) {
  const context = `local801-bidx-key:v1|org:${organizationId}|domain:${domain}|key:${version}`;
  return createHmac("sha256", root).update(context, "utf8").digest();
}

export function createPiiBlindIndex(
  normalizedValue: string,
  input: { organizationId: string; domain: string; keyVersion?: string },
  config: PiiKeyConfiguration = getPiiKeyConfiguration(),
): PiiBlindIndex {
  if (typeof normalizedValue !== "string" || normalizedValue.length === 0 || Buffer.byteLength(normalizedValue, "utf8") > MAX_PLAINTEXT_BYTES) {
    throw new PiiProtectionError("NORMALIZATION_FAILED", "Blind-index input is invalid.");
  }
  const organizationId = requireUuid(input.organizationId, "organizationId");
  const domain = requireDomain(input.domain, "domain");
  const keyVersion = input.keyVersion ?? config.activeBlindIndexKeyVersion;
  if (!KEY_VERSION_RE.test(keyVersion)) throw new PiiProtectionError("KEY_VERSION_INVALID", "Blind-index key version is invalid.");
  const root = config.blindIndexKeys.get(keyVersion);
  if (!root) throw new PiiProtectionError("KEY_NOT_FOUND", "Required PII blind-index key is unavailable.");
  const domainKey = blindDomainKey(root, organizationId, domain, keyVersion);
  try {
    return Object.freeze({
      blindIndex: createHmac("sha256", domainKey).update(normalizedValue, "utf8").digest("hex"),
      blindIndexKeyVersion: keyVersion,
    });
  } finally {
    domainKey.fill(0);
  }
}

export function createPiiIntegrityHash(
  canonicalValue: string,
  input: { organizationId: string; domain: string; keyVersion?: string },
  config: PiiKeyConfiguration = getPiiKeyConfiguration(),
) {
  return createPiiBlindIndex(canonicalValue, { ...input, domain: `integrity:${requireDomain(input.domain, "domain")}` }, config);
}

export function createPiiNameSearchTokens(
  value: string,
  input: { organizationId: string; domain: string; minPrefixLength?: number; maxPrefixLength?: number; keyVersion?: string },
  config: PiiKeyConfiguration = getPiiKeyConfiguration(),
): readonly PiiSearchToken[] {
  const normalized = normalizePiiNameForSearch(value);
  const domain = requireDomain(input.domain, "domain");
  const minPrefixLength = input.minPrefixLength ?? 3;
  const maxPrefixLength = input.maxPrefixLength ?? 20;
  if (!Number.isInteger(minPrefixLength) || !Number.isInteger(maxPrefixLength) || minPrefixLength < 2 || maxPrefixLength < minPrefixLength || maxPrefixLength > 40) {
    throw new PiiProtectionError("SEARCH_POLICY_INVALID", "Name search prefix policy is invalid.");
  }
  const output = new Map<string, PiiSearchToken>();
  for (const word of normalized.split(" ")) {
    const wordIndex = createPiiBlindIndex(word, { organizationId: input.organizationId, domain: `search:${domain}:word`, keyVersion: input.keyVersion }, config);
    output.set(`word:${wordIndex.blindIndex}`, Object.freeze({ tokenHash: wordIndex.blindIndex, tokenKeyVersion: wordIndex.blindIndexKeyVersion, tokenKind: "word" }));
    const characters = Array.from(word);
    const stop = Math.min(characters.length, maxPrefixLength);
    for (let length = minPrefixLength; length <= stop; length += 1) {
      const prefix = characters.slice(0, length).join("");
      const prefixIndex = createPiiBlindIndex(prefix, { organizationId: input.organizationId, domain: `search:${domain}:prefix`, keyVersion: input.keyVersion }, config);
      output.set(`prefix:${prefixIndex.blindIndex}`, Object.freeze({ tokenHash: prefixIndex.blindIndex, tokenKeyVersion: prefixIndex.blindIndexKeyVersion, tokenKind: "prefix" }));
    }
  }
  return Object.freeze([...output.values()]);
}

function cursorAad(organizationId: string, purpose: string, keyVersion: string) {
  return Buffer.from(`local801-pii-cursor:v${CURSOR_FORMAT_VERSION}|org:${organizationId}|purpose:${purpose}|key:${keyVersion}`, "utf8");
}

function cursorKey(root: Buffer, organizationId: string, purpose: string) {
  return derivedAesKey(root, Buffer.from(`local801-pii-cursor-key:v1|org:${organizationId}|purpose:${purpose}`, "utf8"));
}

export function sealPiiCursor(
  payload: unknown,
  input: { organizationId: string; purpose: string; ttlSeconds?: number },
  config: PiiKeyConfiguration = getPiiKeyConfiguration(),
) {
  const organizationId = requireUuid(input.organizationId, "organizationId");
  const purpose = requireDomain(input.purpose, "purpose");
  const ttlSeconds = input.ttlSeconds ?? 15 * 60;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 24 * 60 * 60) throw new PiiProtectionError("CURSOR_INVALID", "Cursor lifetime is invalid.");
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttlSeconds, value: payload }), "utf8");
  if (body.length > MAX_CURSOR_BYTES) {
    body.fill(0);
    throw new PiiProtectionError("CURSOR_TOO_LARGE", "Cursor payload exceeds the maximum size.");
  }
  const keyVersion = config.activeEncryptionKeyVersion;
  const root = config.encryptionKeys.get(keyVersion);
  if (!root) throw new PiiProtectionError("KEY_NOT_FOUND", "Active PII encryption key is unavailable.");
  const key = cursorKey(root, organizationId, purpose);
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(cursorAad(organizationId, purpose, keyVersion));
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `c${CURSOR_FORMAT_VERSION}.${keyVersion}.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
  } finally {
    key.fill(0);
    body.fill(0);
  }
}

export function openPiiCursor<T>(
  cursor: string,
  input: { organizationId: string; purpose: string; nowSeconds?: number },
  config: PiiKeyConfiguration = getPiiKeyConfiguration(),
): T {
  if (typeof cursor !== "string" || cursor.length > 8192) throw new PiiProtectionError("CURSOR_INVALID", "Cursor is invalid.");
  const parts = cursor.split(".");
  if (parts.length !== 5 || parts[0] !== `c${CURSOR_FORMAT_VERSION}` || !KEY_VERSION_RE.test(parts[1])) {
    throw new PiiProtectionError("CURSOR_INVALID", "Cursor is invalid.");
  }
  const [keyVersion, ivPart, ciphertextPart, tagPart] = [parts[1], parts[2], parts[3], parts[4]];
  const decode = (part: string) => {
    const buffer = Buffer.from(part, "base64url");
    if (buffer.toString("base64url") !== part) throw new PiiProtectionError("CURSOR_INVALID", "Cursor is not canonical.");
    return buffer;
  };
  const iv = decode(ivPart);
  const ciphertext = decode(ciphertextPart);
  const tag = decode(tagPart);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_CURSOR_BYTES + 64) throw new PiiProtectionError("CURSOR_INVALID", "Cursor bounds are invalid.");
  const organizationId = requireUuid(input.organizationId, "organizationId");
  const purpose = requireDomain(input.purpose, "purpose");
  const root = config.encryptionKeys.get(keyVersion);
  if (!root) throw new PiiProtectionError("KEY_NOT_FOUND", "Cursor key version is unavailable.");
  const key = cursorKey(root, organizationId, purpose);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(cursorAad(organizationId, purpose, keyVersion));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > MAX_CURSOR_BYTES) {
      plaintext.fill(0);
      throw new PiiProtectionError("CURSOR_INVALID", "Cursor payload is oversized.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PiiProtectionError("CURSOR_INVALID", "Cursor payload is invalid.");
    const record = parsed as { exp?: unknown; value?: unknown };
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isInteger(record.exp) || (record.exp as number) < now) throw new PiiProtectionError("CURSOR_EXPIRED", "Cursor has expired.");
    return record.value as T;
  } catch (error) {
    if (error instanceof PiiProtectionError) throw error;
    throw new PiiProtectionError("CURSOR_INVALID", "Cursor authentication failed.");
  } finally {
    key.fill(0);
  }
}

export const __testing = {
  CURSOR_FORMAT_VERSION,
  DOMAIN_RE,
  FIELD_FORMAT_VERSION,
  KEY_VERSION_RE,
  MAX_CURSOR_BYTES,
  MAX_KEY_VERSIONS,
  MAX_PLAINTEXT_BYTES,
  UUID_RE,
  parseKeyring,
};

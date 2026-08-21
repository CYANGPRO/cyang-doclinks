import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  createPiiBlindIndex,
  createPiiIntegrityHash,
  createPiiNameSearchTokens,
  decryptPiiField,
  encryptPiiField,
  getPiiKeyConfiguration,
  normalizePiiContactValue,
  normalizePiiEmail,
  normalizePiiIdentifier,
  normalizePiiNameForSearch,
  openPiiCursor,
  piiKeyConfigurationValid,
  PiiProtectionError,
  sealPiiCursor,
} from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "99999999-9999-4999-8999-999999999999";
const recordId = "22222222-2222-4222-8222-222222222222";
const otherRecordId = "33333333-3333-4333-8333-333333333333";
const key = (byte) => Buffer.alloc(32, byte).toString("base64");

function env(overrides = {}) {
  return {
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: key(1), v2: key(2) }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v2",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: key(3), v2: key(4) }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v2",
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    organizationId,
    entity: "people",
    recordId,
    field: "first_name",
    ...overrides,
  };
}

test("PII keyrings require canonical independent 32-byte keys and configured active versions", () => {
  const config = getPiiKeyConfiguration(env());
  assert.equal(config.encryptionKeys.size, 2);
  assert.equal(config.blindIndexKeys.size, 2);
  assert.equal(config.activeEncryptionKeyVersion, "v2");
  assert.equal(config.activeBlindIndexKeyVersion, "v2");
  assert.equal(piiKeyConfigurationValid(env()), true);
  assert.equal(piiKeyConfigurationValid({}), false);
  assert.throws(() => getPiiKeyConfiguration(env({ LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v9" })), /configured key version/i);
  assert.throws(() => getPiiKeyConfiguration(env({ LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: "bad" }) })), /32-byte key/i);
  assert.throws(() => getPiiKeyConfiguration(env({ LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: key(1), v2: key(1) }) })), /reuse the same key material/i);
});

test("field encryption is randomized, round-trips, and binds organization/entity/record/field AAD", () => {
  const config = getPiiKeyConfiguration(env());
  const first = encryptPiiField("Avery Synthetic", context(), config);
  const second = encryptPiiField("Avery Synthetic", context(), config);
  assert.equal(first.encryptionKeyVersion, "v2");
  assert.equal(first.encryptionFormatVersion, 1);
  assert.notEqual(first.encryptedPayload, second.encryptedPayload);
  assert.equal(first.encryptedPayload.includes("Avery"), false);
  assert.equal(decryptPiiField(first, context(), config), "Avery Synthetic");

  for (const wrong of [
    context({ organizationId: otherOrganizationId }),
    context({ entity: "users" }),
    context({ recordId: otherRecordId }),
    context({ field: "last_name" }),
  ]) {
    assert.throws(() => decryptPiiField(first, wrong, config), (error) => error instanceof PiiProtectionError && error.code === "AUTHENTICATION_FAILED");
  }
});

test("field ciphertext tamper, malformed envelopes, unknown versions, and oversized plaintext fail closed", () => {
  const config = getPiiKeyConfiguration(env());
  const encrypted = encryptPiiField("Sensitive Value", context(), config);
  const parts = encrypted.encryptedPayload.split(".");
  parts[2] = `${parts[2].slice(0, -1)}${parts[2].endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptPiiField({ ...encrypted, encryptedPayload: parts.join(".") }, context(), config), PiiProtectionError);
  assert.throws(() => decryptPiiField({ ...encrypted, encryptedPayload: "p1.bad.bad.bad" }, context(), config), PiiProtectionError);
  assert.throws(() => decryptPiiField({ ...encrypted, encryptionKeyVersion: "v9" }, context(), config), (error) => error instanceof PiiProtectionError && error.code === "KEY_NOT_FOUND");
  assert.throws(() => encryptPiiField("x".repeat(__testing.MAX_PLAINTEXT_BYTES + 1), context(), config), (error) => error instanceof PiiProtectionError && error.code === "PLAINTEXT_TOO_LARGE");
});

test("encryption key rotation reads old ciphertext while new writes use the active key", () => {
  const oldConfig = getPiiKeyConfiguration(env({ LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1" }));
  const oldCiphertext = encryptPiiField("Rotation Test", context(), oldConfig);
  assert.equal(oldCiphertext.encryptionKeyVersion, "v1");

  const rotatedConfig = getPiiKeyConfiguration(env({ LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v2" }));
  const newCiphertext = encryptPiiField("Rotation Test", context(), rotatedConfig);
  assert.equal(newCiphertext.encryptionKeyVersion, "v2");
  assert.equal(decryptPiiField(oldCiphertext, context(), rotatedConfig), "Rotation Test");
  assert.equal(decryptPiiField(newCiphertext, context(), rotatedConfig), "Rotation Test");
});

test("normalization is deterministic for emails, identifiers, names, and contact values", () => {
  assert.equal(normalizePiiEmail("  Avery.Synthetic@EXAMPLE.TEST \n"), "avery.synthetic@example.test");
  assert.equal(normalizePiiIdentifier("  AB-123  "), "AB-123");
  assert.equal(normalizePiiIdentifier("ＡＢ１２３"), "AB123");
  assert.equal(normalizePiiNameForSearch("  AVERY—Synthetic  Xiong-Yang "), "avery synthetic xiong yang");
  assert.equal(normalizePiiContactValue("work_email", " Test@Example.Test "), "test@example.test");
  assert.equal(normalizePiiContactValue("mailing_address", " 123   Test St \n Unit 2 "), "123 Test St Unit 2");
  assert.throws(() => normalizePiiEmail("not-an-email"), /invalid/i);
});

test("blind indexes are stable but domain, organization, and key-version separated", () => {
  const config = getPiiKeyConfiguration(env());
  const value = normalizePiiEmail("Person@Example.Test");
  const first = createPiiBlindIndex(value, { organizationId, domain: "work_email" }, config);
  const again = createPiiBlindIndex(value, { organizationId, domain: "work_email" }, config);
  const otherDomain = createPiiBlindIndex(value, { organizationId, domain: "user_email" }, config);
  const otherOrg = createPiiBlindIndex(value, { organizationId: otherOrganizationId, domain: "work_email" }, config);
  const oldVersion = createPiiBlindIndex(value, { organizationId, domain: "work_email", keyVersion: "v1" }, config);
  assert.match(first.blindIndex, /^[0-9a-f]{64}$/);
  assert.equal(first.blindIndex, again.blindIndex);
  assert.equal(first.blindIndexKeyVersion, "v2");
  assert.notEqual(first.blindIndex, otherDomain.blindIndex);
  assert.notEqual(first.blindIndex, otherOrg.blindIndex);
  assert.notEqual(first.blindIndex, oldVersion.blindIndex);
});

test("integrity hashes are keyed and domain-separated from ordinary lookup indexes", () => {
  const config = getPiiKeyConfiguration(env());
  const canonical = "source-file|sheet|42|protected-row";
  const integrity = createPiiIntegrityHash(canonical, { organizationId, domain: "import_row" }, config);
  const lookup = createPiiBlindIndex(canonical, { organizationId, domain: "import_row" }, config);
  assert.match(integrity.blindIndex, /^[0-9a-f]{64}$/);
  assert.notEqual(integrity.blindIndex, lookup.blindIndex);
  assert.equal(integrity.blindIndexKeyVersion, "v2");
});

test("name search tokens contain only keyed hashes and support bounded word/prefix generation", () => {
  const config = getPiiKeyConfiguration(env());
  const tokens = createPiiNameSearchTokens("Avery Synthetic", { organizationId, domain: "combined_name", minPrefixLength: 3, maxPrefixLength: 6 }, config);
  assert.equal(tokens.length > 0, true);
  assert.equal(tokens.some((token) => token.tokenKind === "word"), true);
  assert.equal(tokens.some((token) => token.tokenKind === "prefix"), true);
  for (const token of tokens) {
    assert.match(token.tokenHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(token).includes("avery"), false);
    assert.equal(token.tokenKeyVersion, "v2");
  }
  assert.throws(() => createPiiNameSearchTokens("Avery", { organizationId, domain: "combined_name", minPrefixLength: 1 }, config), /prefix policy/i);
});

test("opaque cursors hide plaintext/internal IDs, bind purpose+organization, expire, and rotate", () => {
  const config = getPiiKeyConfiguration(env());
  const payload = { sort: "xiong|avery", personId: recordId };
  const cursor = sealPiiCursor(payload, { organizationId, purpose: "directory", ttlSeconds: 300 }, config);
  assert.equal(cursor.includes("xiong"), false);
  assert.equal(cursor.includes(recordId), false);
  assert.deepEqual(openPiiCursor(cursor, { organizationId, purpose: "directory" }, config), payload);
  assert.throws(() => openPiiCursor(cursor, { organizationId: otherOrganizationId, purpose: "directory" }, config), PiiProtectionError);
  assert.throws(() => openPiiCursor(cursor, { organizationId, purpose: "outreach" }, config), PiiProtectionError);
  assert.throws(() => openPiiCursor(cursor, { organizationId, purpose: "directory", nowSeconds: Math.floor(Date.now() / 1000) + 301 }, config), (error) => error instanceof PiiProtectionError && error.code === "CURSOR_EXPIRED");

  const oldConfig = getPiiKeyConfiguration(env({ LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1" }));
  const oldCursor = sealPiiCursor({ page: 2 }, { organizationId, purpose: "directory" }, oldConfig);
  assert.deepEqual(openPiiCursor(oldCursor, { organizationId, purpose: "directory" }, config), { page: 2 });
});

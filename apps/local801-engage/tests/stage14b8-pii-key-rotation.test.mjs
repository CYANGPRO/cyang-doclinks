import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createPiiBlindIndex,
  decryptPiiField,
  encryptPiiField,
  getPiiKeyConfiguration,
} from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";

function keyConfig(activeEncryption = "v2", activeBlind = "v2") {
  return getPiiKeyConfiguration({
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 41).toString("base64"),
      v2: Buffer.alloc(32, 43).toString("base64"),
    }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: activeEncryption,
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 47).toString("base64"),
      v2: Buffer.alloc(32, 53).toString("base64"),
    }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: activeBlind,
  });
}

test("PII crypto supports decrypting an old envelope while the new encryption key is active", () => {
  const oldConfig = keyConfig("v1", "v1");
  const encrypted = encryptPiiField("rotation@example.test", {
    organizationId, entity: "user", recordId, field: "email",
  }, oldConfig);
  const rotatedConfig = keyConfig("v2", "v2");
  assert.equal(encrypted.encryptionKeyVersion, "v1");
  assert.equal(decryptPiiField(encrypted, {
    organizationId, entity: "user", recordId, field: "email",
  }, rotatedConfig), "rotation@example.test");
});

test("blind-index rotation produces distinct generations and both keys can coexist", () => {
  const config = keyConfig();
  const oldIndex = createPiiBlindIndex("rotation@example.test", {
    organizationId, domain: "user:email", keyVersion: "v1",
  }, config);
  const newIndex = createPiiBlindIndex("rotation@example.test", {
    organizationId, domain: "user:email", keyVersion: "v2",
  }, config);
  assert.equal(oldIndex.blindIndexKeyVersion, "v1");
  assert.equal(newIndex.blindIndexKeyVersion, "v2");
  assert.notEqual(oldIndex.blindIndex, newIndex.blindIndex);
});

test("rotation tracking migration is additive and requires apply, verify, then retire semantics", async () => {
  const migration = await readFile(new URL("../db/migrations/0017__pii_key_rotation_tracking.sql", import.meta.url), "utf8");
  assert.match(migration, /create table if not exists local801\.pii_key_rotation_runs/);
  assert.match(migration, /state in \('planned','applied','verified','retired','failed'\)/);
  assert.match(migration, /state <> 'verified' or \(applied_at is not null and verified_at is not null\)/);
  assert.match(migration, /state <> 'retired' or \(applied_at is not null and verified_at is not null and retired_at is not null\)/);
  assert.match(migration, /where state in \('planned','applied'\)/);
  assert.doesNotMatch(migration, /drop\s+(table|column)/i);
});

test("rotation tool is protected-only, explicit, quiesced, and confirmation-gated", async () => {
  const source = await readFile(new URL("../scripts/rotate-protected-pii.mjs", import.meta.url), "utf8");
  assert.match(source, /LOCAL801_DATABASE_PII_PROTECTION_ENABLED !== "1"/);
  assert.match(source, /LOCAL801_PII_DUAL_WRITE_ENABLED === "1"/);
  assert.match(source, /LOCAL801_PII_BACKFILL_ENABLED === "1"/);
  assert.match(source, /LOCAL801_PII_KEY_ROTATION_ENABLED !== "1"/);
  assert.match(source, /LOCAL801_PII_ROTATION_WRITES_QUIESCED !== "1"/);
  assert.match(source, /ROTATE_PROTECTED_PII/);
  assert.match(source, /source encryption key must remain in the configured keyring/);
  assert.match(source, /source blind-index key must remain in the configured keyring/);
  assert.match(source, /active encryption key must be the new target version/);
  assert.match(source, /active blind-index key must be the new target version/);
});

test("rotation apply decrypts from protected companions and rebuilds only the target index generation", async () => {
  const source = await readFile(new URL("../scripts/rotate-protected-pii.mjs", import.meta.url), "utf8");
  assert.match(source, /join local801\.user_pii protected/);
  assert.match(source, /join local801\.auth_identity_pii protected/);
  assert.match(source, /join local801\.person_pii protected/);
  assert.match(source, /join local801\.person_identifier_pii protected/);
  assert.match(source, /join local801\.person_contact_method_pii protected/);
  assert.match(source, /join local801\.import_file_pii protected/);
  assert.match(source, /join local801\.import_row_pii protected/);
  assert.match(source, /join local801\.push_subscription_pii protected/);
  assert.match(source, /delete from local801\.pii_exact_indexes where organization_id=\$\{organizationId\}::uuid and index_key_version=\$\{targetBlindVersion\}/);
  assert.match(source, /delete from local801\.person_search_tokens where organization_id=\$\{organizationId\}::uuid and token_key_version=\$\{targetBlindVersion\}/);
  const applySection = source.slice(source.indexOf("async function upsertPlan"), source.indexOf("async function latestRun"));
  assert.doesNotMatch(applySection, /index_key_version=\$\{fromBlindVersion\}/);
  assert.doesNotMatch(applySection, /token_key_version=\$\{fromBlindVersion\}/);
});

test("rotation coverage is verified on the same transaction before applied state is committed", async () => {
  const source = await readFile(new URL("../scripts/rotate-protected-pii.mjs", import.meta.url), "utf8");
  assert.match(source, /async function versionCoverage\(organizationId, db = sql\)/);
  assert.match(source, /const \[row\] = await db`/);
  assert.match(source, /const coverage = await versionCoverage\(organizationId, tx\);/);
  const applyStart = source.indexOf("async function applyRotation");
  const verifyStart = source.indexOf("async function verifyRotation");
  const applySection = source.slice(applyStart, verifyStart);
  assert.ok(applySection.indexOf("versionCoverage(organizationId, tx)") < applySection.indexOf("state='applied'"));
});

test("old blind-index generation cannot be retired until a verified run and old encryption references are gone", async () => {
  const source = await readFile(new URL("../scripts/rotate-protected-pii.mjs", import.meta.url), "utf8");
  const retireStart = source.indexOf("async function retireOldIndexes");
  const retireSection = source.slice(retireStart);
  assert.match(retireSection, /latestRun\(organizationId, \["verified"\]\)/);
  assert.match(retireSection, /old encryption key is still referenced by protected companions/);
  assert.match(retireSection, /delete from local801\.pii_exact_indexes where organization_id=\$\{organizationId\}::uuid and index_key_version=\$\{fromBlindVersion\}/);
  assert.match(retireSection, /delete from local801\.person_search_tokens where organization_id=\$\{organizationId\}::uuid and token_key_version=\$\{fromBlindVersion\}/);
  assert.match(retireSection, /state='retired'/);
});

test("rotation output is metadata-only and explicitly records that raw PII is not logged", async () => {
  const source = await readFile(new URL("../scripts/rotate-protected-pii.mjs", import.meta.url), "utf8");
  assert.match(source, /rawPiiLogged: false/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(email|first_name|last_name|provider_subject|contact_value|identifier_value)/i);
});

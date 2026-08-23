import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const protectedAuthUrl = new URL("../src/lib/pii-protected-production-auth.ts", import.meta.url);
const productionAuthUrl = new URL("../src/lib/production-auth.ts", import.meta.url);

test("protected production auth resolves email and provider subject through blind indexes", async () => {
  const source = await readFile(protectedAuthUrl, "utf8");
  assert.match(source, /index_domain = 'user:email'/);
  assert.match(source, /auth:provider-subject:/);
  assert.match(source, /pii_exact_indexes/);
  assert.match(source, /decryptPiiField/);
  assert.match(source, /normalizePiiEmail\(storedEmail\)/);
  assert.doesNotMatch(source, /lower\(app_user\.email\)\s*=\s*lower/);
  assert.doesNotMatch(source, /provider_subject\s*=\s*\$[0-9]+/);
  assert.match(source, /production_initializations/);
  assert.match(source, /initial_system_owner_id/);
  assert.match(source, /identity\.bootstrapObjectMatched/);
  assert.match(source, /role\.code = 'system_owner'/);
});

test("new protected OIDC links place only non-PII placeholders in legacy identity columns", async () => {
  const source = await readFile(protectedAuthUrl, "utf8");
  assert.match(source, /placeholderSubject = `protected:\$\{identityId\}`/);
  assert.match(source, /placeholderEmail = `protected-\$\{identityId\}@invalid\.local`/);
  assert.match(source, /INSERT INTO local801\.auth_identity_pii/);
  assert.match(source, /provider_subject_encrypted_payload/);
  assert.match(source, /linked_email_encrypted_payload/);
});

test("production auth dispatches to protected implementation only after the database protection switch", async () => {
  const source = await readFile(productionAuthUrl, "utf8");
  const gates = source.match(/LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"/g) ?? [];
  assert.equal(gates.length >= 2, true);
  assert.match(source, /authorizeProtectedProductionIdentity/);
  assert.match(source, /resolveProtectedProductionSessionBinding/);
});
